import { createClient } from "redis";
import { PubSub } from "graphql-subscriptions";

export const TELEMETRY_UPDATED = "TELEMETRY_UPDATED";
export const TENANT_TELEMETRY_UPDATED = "TENANT_TELEMETRY_UPDATED";

// Redis-backed pub/sub so subscriptions work correctly across multiple BFF pods.
// Uses two separate Redis connections — one for publish, one for subscribe —
// as required by the Redis protocol (a subscribed connection can only receive).

const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";

function makeRedisClient() {
  const client = createClient({ url: REDIS_URL });
  client.on("error", (err) =>
    console.error(JSON.stringify({ level: "error", service: "bff", message: "Redis pubsub error", err: String(err) }))
  );
  return client;
}

class RedisPubSub {
  private publisher  = makeRedisClient();
  private subscriber = makeRedisClient();
  private handlers   = new Map<string, Set<(message: string) => void>>();
  private _ready: Promise<void>;

  constructor() {
    this._ready = Promise.all([
      this.publisher.connect(),
      this.subscriber.connect(),
    ]).then(() => {
      console.log(JSON.stringify({ level: "info", service: "bff", message: "Redis pubsub connected" }));
    });
  }

  async ready(): Promise<void> {
    return this._ready;
  }

  async publish(channel: string, payload: unknown): Promise<void> {
    await this._ready;
    await this.publisher.publish(channel, JSON.stringify(payload));
  }

  async subscribe(channel: string, handler: (payload: unknown) => void): Promise<() => Promise<void>> {
    await this._ready;

    const wrappedHandler = (message: string) => {
      try {
        handler(JSON.parse(message));
      } catch {
        // ignore malformed messages
      }
    };

    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set());
      await this.subscriber.subscribe(channel, (message) => {
        this.handlers.get(channel)?.forEach((h) => h(message));
      });
    }

    this.handlers.get(channel)!.add(wrappedHandler);

    // Return unsubscribe function
    return async () => {
      const set = this.handlers.get(channel);
      if (!set) return;
      set.delete(wrappedHandler);
      if (set.size === 0) {
        this.handlers.delete(channel);
        await this.subscriber.unsubscribe(channel);
      }
    };
  }
}

// Singleton shared across all resolvers in this pod
const redisPubSub = new RedisPubSub();

// Wrap in graphql-subscriptions PubSub interface so resolvers don't change
class BridgedPubSub extends PubSub {
  async publish(triggerName: string, payload: unknown): Promise<void> {
    await redisPubSub.publish(triggerName, payload);
  }

  asyncIterator<T>(triggers: string | string[]): AsyncIterableIterator<T> {
    const channels = Array.isArray(triggers) ? triggers : [triggers];
    return this._makeAsyncIterableIterator<T>(channels);
  }

  private _makeAsyncIterableIterator<T>(channels: string[]): AsyncIterableIterator<T> {
    const queue: T[] = [];
    const waiters: Array<(value: IteratorResult<T>) => void> = [];
    const unsubscribers: Array<() => Promise<void>> = [];
    let done = false;

    const push = (value: unknown) => {
      if (waiter = waiters.shift()) {
        waiter({ value: value as T, done: false });
      } else {
        queue.push(value as T);
      }
    };

    let waiter: ((value: IteratorResult<T>) => void) | undefined;

    // Subscribe to all channels
    Promise.all(
      channels.map((ch) => redisPubSub.subscribe(ch, push).then((unsub) => unsubscribers.push(unsub)))
    ).catch(console.error);

    return {
      next(): Promise<IteratorResult<T>> {
        if (queue.length > 0) {
          return Promise.resolve({ value: queue.shift()!, done: false });
        }
        if (done) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => waiters.push(resolve));
      },
      async return(): Promise<IteratorResult<T>> {
        done = true;
        await Promise.all(unsubscribers.map((u) => u()));
        waiters.forEach((w) => w({ value: undefined as unknown as T, done: true }));
        return { value: undefined as unknown as T, done: true };
      },
      async throw(err?: unknown): Promise<IteratorResult<T>> {
        done = true;
        await Promise.all(unsubscribers.map((u) => u()));
        return Promise.reject(err);
      },
      [Symbol.asyncIterator]() { return this; },
    };
  }
}

export const pubsub = new BridgedPubSub();
