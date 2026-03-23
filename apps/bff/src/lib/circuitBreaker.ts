/**
 * Circuit Breaker — protects BFF from Postgres failures
 *
 * States:
 *   CLOSED    → normal operation, requests flow through
 *   OPEN      → Postgres unhealthy, requests fail fast
 *   HALF_OPEN → testing recovery, one request allowed
 */

type State = "CLOSED" | "OPEN" | "HALF_OPEN";

interface CircuitBreakerOptions {
  failureThreshold?: number;  // failures before opening  (default: 5)
  successThreshold?: number;  // successes to close again (default: 2)
  timeout?: number;           // ms before HALF_OPEN test (default: 30000)
  name?: string;              // for logging
}

export class CircuitBreaker {
  private state: State = "CLOSED";
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly timeout: number;
  private readonly name: string;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.successThreshold = opts.successThreshold ?? 2;
    this.timeout          = opts.timeout          ?? 30_000;
    this.name             = opts.name             ?? "circuit-breaker";
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // OPEN — check if timeout has elapsed to move to HALF_OPEN
    if (this.state === "OPEN") {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed < this.timeout) {
        const remaining = Math.round((this.timeout - elapsed) / 1000);
        throw new Error(
          `[${this.name}] Circuit OPEN — Postgres unavailable. Retry in ${remaining}s`
        );
      }
      // Timeout elapsed — test with one request
      console.warn(
        JSON.stringify({
          level: "warn",
          service: "bff",
          circuit: this.name,
          state: "HALF_OPEN",
          msg: "testing recovery",
        })
      );
      this.state = "HALF_OPEN";
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err: any) {
      // Only count real infrastructure failures (connection loss, timeout).
      // Bad SQL (invalid UUID, syntax errors) are app bugs, not Postgres outages.
      const isInfraFailure =
        err?.code === "ECONNREFUSED" ||
        err?.code === "ENOTFOUND" ||
        err?.code === "ETIMEDOUT" ||
        err?.code === "ECONNRESET" ||
        err?.message?.includes("Connection terminated") ||
        err?.message?.includes("connect ECONNREFUSED");

      if (isInfraFailure) this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;

    if (this.state === "HALF_OPEN") {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = "CLOSED";
        this.successCount = 0;
        console.log(
          JSON.stringify({
            level: "info",
            service: "bff",
            circuit: this.name,
            state: "CLOSED",
            msg: "circuit closed — Postgres recovered",
          })
        );
      }
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === "HALF_OPEN") {
      // Failed during test — reopen immediately
      this.state = "OPEN";
      this.successCount = 0;
      console.error(
        JSON.stringify({
          level: "error",
          service: "bff",
          circuit: this.name,
          state: "OPEN",
          msg: "circuit reopened — recovery test failed",
        })
      );
      return;
    }

    if (this.failureCount >= this.failureThreshold) {
      this.state = "OPEN";
      console.error(
        JSON.stringify({
          level: "error",
          service: "bff",
          circuit: this.name,
          state: "OPEN",
          failures: this.failureCount,
          msg: "circuit opened — failure threshold exceeded",
        })
      );
    }
  }

  getState(): State {
    return this.state;
  }

  getStats() {
    return {
      state:        this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
    };
  }
}

// Singleton instance for Postgres
export const postgresCircuitBreaker = new CircuitBreaker({
  name:             "postgres",
  failureThreshold: 5,
  successThreshold: 2,
  timeout:          30_000,
});

