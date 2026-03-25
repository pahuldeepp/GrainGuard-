package health

import (
    "context"
    "fmt"
    "net"                                        // ← was missing

    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/redis/go-redis/v9"
)

type Checker interface {
    Name() string
    Check(ctx context.Context) error
}

type postgresChecker struct{ pool *pgxpool.Pool }

func NewPostgresChecker(pool *pgxpool.Pool) Checker { return &postgresChecker{pool} }
func (c *postgresChecker) Name() string             { return "postgres" }
func (c *postgresChecker) Check(ctx context.Context) error { return c.pool.Ping(ctx) }

type redisChecker struct{ client redis.UniversalClient }

func NewRedisChecker(client redis.UniversalClient) Checker { return &redisChecker{client} }
func (c *redisChecker) Name() string                       { return "redis" }
func (c *redisChecker) Check(ctx context.Context) error {
    return c.client.Ping(ctx).Err()
}

type tcpChecker struct {
    name    string
    address string
}

func NewKafkaChecker(brokerAddr string) Checker {
    return &tcpChecker{name: "kafka", address: brokerAddr}
}
func (c *tcpChecker) Name() string { return c.name }
func (c *tcpChecker) Check(ctx context.Context) error {
    d := &net.Dialer{}
    conn, err := d.DialContext(ctx, "tcp", c.address)
    if err != nil {
        return fmt.Errorf("dial %s: %w", c.address, err)
    }
    conn.Close()
    return nil
}
