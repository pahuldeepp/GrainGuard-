package consumer

import (
	"sync"
	"time"
)

type CircuitBreaker struct {
	mu               sync.Mutex
	failures         int
	failureThreshold int
	state            string
	resetTimeout     time.Duration
	lastFailureTime  time.Time
	halfOpenAllowed  bool
}

const (
	StateClosed   = "closed"
	StateOpen     = "open"
	StateHalfOpen = "half-open"
)

func NewCircuitBreaker(threshold int, timeout time.Duration) *CircuitBreaker {
	return &CircuitBreaker{
		failureThreshold: threshold,
		resetTimeout:     timeout,
		state:            StateClosed,
	}
}
func (cb *CircuitBreaker) Allow() bool {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	switch cb.state {

	case StateOpen:
		if time.Since(cb.lastFailureTime) > cb.resetTimeout {
			cb.state = StateHalfOpen
			cb.halfOpenAllowed = true
			return true
		}
		return false

	case StateHalfOpen:
		if cb.halfOpenAllowed {
			cb.halfOpenAllowed = false
			return true
		}
		return false

	default: // closed
		return true
	}
}

func (cb *CircuitBreaker) Success() {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	cb.failures = 0
	cb.state = StateClosed
	cb.halfOpenAllowed = false
}

func (cb *CircuitBreaker) Failure() {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	cb.failures++

	if cb.state == StateHalfOpen {
		cb.state = StateOpen
		cb.lastFailureTime = time.Now()
		cb.halfOpenAllowed = false
		return
	}

	if cb.failures >= cb.failureThreshold {
		cb.state = StateOpen
		cb.lastFailureTime = time.Now()
	}
}
