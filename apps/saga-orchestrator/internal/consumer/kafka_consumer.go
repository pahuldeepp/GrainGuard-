package consumer

import (
	"context"
	"errors"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/segmentio/kafka-go"

	"github.com/pahuldeepp/grainguard/apps/read-model-builder/internal/observability"
)

type KafkaConsumer struct {
	group     *kafka.ConsumerGroup
	dlqWriter *kafka.Writer
	topic     string
}

func NewKafkaConsumerFromEnv(topic string, groupID string) *KafkaConsumer {
	brokers := os.Getenv("KAFKA_BROKERS")
	if brokers == "" {
		brokers = "localhost:9092"
	}
	brokerList := strings.Split(brokers, ",")

	// ConsumerGroup = rebalance-aware + dynamically scales with partitions
	cg := kafka.NewConsumerGroup(kafka.ConsumerGroupConfig{
		ID:      groupID,
		Brokers: brokerList,
		Topics:  []string{topic},
		// Tweak if you want:
		// GroupBalancers: []kafka.GroupBalancer{kafka.RangeGroupBalancer{}},
	})

	dlqWriter := &kafka.Writer{
		Addr:     kafka.TCP(brokerList...),
		Topic:    topic + ".dlq",
		Balancer: &kafka.LeastBytes{},
	}

	return &KafkaConsumer{
		group:     cg,
		dlqWriter: dlqWriter,
		topic:     topic,
	}
}

func (c *KafkaConsumer) Close() error {
	var err1, err2 error
	if c.group != nil {
		err1 = c.group.Close()
	}
	if c.dlqWriter != nil {
		err2 = c.dlqWriter.Close()
	}
	if err1 != nil {
		return err1
	}
	return err2
}

func (c *KafkaConsumer) sendToDLQ(ctx context.Context, msg kafka.Message, reason error) error {
	dlqMsg := kafka.Message{
		Key:   msg.Key,
		Value: msg.Value,
		Headers: append(msg.Headers,
			kafka.Header{Key: "x-error", Value: []byte(reason.Error())},
		),
	}
	return c.dlqWriter.WriteMessages(ctx, dlqMsg)
}

type job struct{ msg kafka.Message }
type done struct{ msg kafka.Message }

// Per-partition ordered-commit state (keeps ordering SAFE)
type commitState struct {
	nextOffset  int64
	pending     map[int64]kafka.Message
	initialized bool
}

func (c *KafkaConsumer) Start(ctx context.Context, handler func([]byte) error) {
	const (
		workerCount    = 16              // throughput knob
		jobsBuffer     = 2000            // backpressure buffer
		maxRetries     = 3
		retryDelay     = 2 * time.Second
		commitInterval = 2 * time.Second // periodic commit flush
	)

	for {
		if ctx.Err() != nil {
			return
		}

		// ----- This blocks until we join a generation (rebalance-aware) -----
		gen, err := c.group.Next(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Printf("consumer group Next() error: %v", err)
			time.Sleep(time.Second)
			continue
		}

		log.Printf("Joined generation: member=%s generationID=%d assignments=%v",
			gen.MemberID, gen.GenerationID, gen.Assignments)

		// Generation-scoped channels & cancellation:
		// When a rebalance happens, gen.Done() is closed -> we stop safely.
		jobs := make(chan job, jobsBuffer)
		doneCh := make(chan done, jobsBuffer)

		// --- 1) Commit controller (ordered per partition) ---
		var commitWG sync.WaitGroup
		commitWG.Add(1)

		go func() {
			defer commitWG.Done()

			ticker := time.NewTicker(commitInterval)
			defer ticker.Stop()

			states := map[int]*commitState{}
			var mu sync.Mutex

			flushPartition := func(p int) {
				st := states[p]
				if st == nil || !st.initialized {
					return
				}
				var last *kafka.Message
				for {
					m, ok := st.pending[st.nextOffset]
					if !ok {
						break
					}
					last = &m
					delete(st.pending, st.nextOffset)
					st.nextOffset++
				}
				if last != nil {
					flushCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					_ = gen.CommitMessages(flushCtx, *last)
					cancel()
				}
			}

			for {
				select {
				case <-gen.Done():
					// rebalance: flush what’s safely contiguous
					mu.Lock()
					for p := range states {
						flushPartition(p)
					}
					mu.Unlock()
					return

				case <-ctx.Done():
					mu.Lock()
					for p := range states {
						flushPartition(p)
					}
					mu.Unlock()
					return

				case <-ticker.C:
					mu.Lock()
					for p := range states {
						flushPartition(p)
					}
					mu.Unlock()

				case d, ok := <-doneCh:
					if !ok {
						mu.Lock()
						for p := range states {
							flushPartition(p)
						}
						mu.Unlock()
						return
					}

					p := d.msg.Partition
					off := d.msg.Offset

					mu.Lock()
					st := states[p]
					if st == nil {
						st = &commitState{pending: make(map[int64]kafka.Message)}
						states[p] = st
					}
					if !st.initialized {
						st.initialized = true
						st.nextOffset = off
					}
					st.pending[off] = d.msg
					flushPartition(p)
					mu.Unlock()
				}
			}
		}()

		// --- 2) Worker pool ---
		var workersWG sync.WaitGroup
		for i := 0; i < workerCount; i++ {
			workersWG.Add(1)
			go func(workerID int) {
				defer workersWG.Done()

				for {
					select {
					case <-gen.Done():
						return
					case <-ctx.Done():
						return
					case j, ok := <-jobs:
						if !ok {
							return
						}

						observability.InflightJobs.Inc()
						start := time.Now()

						msg := j.msg
						var err error

						for attempt := 1; attempt <= maxRetries; attempt++ {
							err = handler(msg.Value)
							if err == nil {
								break
							}
							observability.EventsRetry.Inc()

							log.Printf("[worker=%d partition=%d offset=%d] handler failed attempt=%d err=%v",
								workerID, msg.Partition, msg.Offset, attempt, err)

							select {
							case <-gen.Done():
								observability.InflightJobs.Dec()
								return
							case <-ctx.Done():
								observability.InflightJobs.Dec()
								return
							case <-time.After(retryDelay):
							}
						}

						observability.HandlerLatency.Observe(time.Since(start).Seconds())

						if err != nil {
							// DLQ then mark as done so commit can advance
							if dlqErr := c.sendToDLQ(ctx, msg, err); dlqErr != nil {
								// DLQ failed -> do NOT mark done (will be retried after rebalance/restart)
								log.Printf("[worker=%d partition=%d offset=%d] DLQ failed: %v",
									workerID, msg.Partition, msg.Offset, dlqErr)
								observability.InflightJobs.Dec()
								continue
							}
							observability.EventsDLQ.Inc()
							select {
							case doneCh <- done{msg: msg}:
							case <-gen.Done():
							case <-ctx.Done():
							}
							observability.InflightJobs.Dec()
							continue
						}

						observability.EventsProcessed.Inc()
						select {
						case doneCh <- done{msg: msg}:
						case <-gen.Done():
						case <-ctx.Done():
						}
						observability.InflightJobs.Dec()
					}
				}
			}(i)
		}

		// --- 3) Generation dispatcher: fetch only while this generation is valid ---
		dispatchErr := func() error {
			for {
				select {
				case <-gen.Done():
					return nil // rebalance -> stop generation cleanly
				case <-ctx.Done():
					return ctx.Err()
				default:
				}

				msg, err := gen.FetchMessage(ctx)
				if err != nil {
					observability.KafkaFetchErrors.Inc()

					// If generation ended due to rebalance, exit cleanly
					if errors.Is(err, context.Canceled) || ctx.Err() != nil {
						return ctx.Err()
					}
					// transient error; keep going
					log.Printf("FetchMessage error: %v", err)
					time.Sleep(time.Second)
					continue
				}

				// Lag metrics are less direct on ConsumerGroup. Keep simple:
				// You can still graph throughput/retry/DLQ; lag can be added later with admin queries.

				select {
				case jobs <- job{msg: msg}:
				case <-gen.Done():
					return nil
				case <-ctx.Done():
					return ctx.Err()
				}
			}
		}()

		// Stop this generation safely: stop workers, close channels, flush commits
		close(jobs)
		workersWG.Wait()
		close(doneCh)
		commitWG.Wait()

		// If context is done, exit; else loop to join next generation
		if dispatchErr != nil && !errors.Is(dispatchErr, context.Canceled) && !errors.Is(dispatchErr, context.DeadlineExceeded) {
			// Non-fatal; keep running
			log.Printf("generation ended with error: %v", dispatchErr)
		}
		if ctx.Err() != nil {
			return
		}
	}
}