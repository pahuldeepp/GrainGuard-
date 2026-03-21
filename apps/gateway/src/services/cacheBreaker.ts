let failureCount = 0;
let isOpen = false;
let openedAt = 0;

const FAILURE_THRESHOLD = 5;
const COOL_DOWN_MS = 20000; // 20 seconds

export function recordFailure() {
  failureCount++;

  if (failureCount >= FAILURE_THRESHOLD && !isOpen) {
    isOpen = true;
    openedAt = Date.now();
    console.log("🔴 Redis circuit breaker OPEN");
  }
}

export function recordSuccess() {
  failureCount = 0;
}

export function allowRequest(): boolean {
  if (!isOpen) return true;

  const now = Date.now();
  if (now - openedAt > COOL_DOWN_MS) {
    console.log("🟡 Redis circuit breaker HALF-OPEN");
    isOpen = false;
    failureCount = 0;
    return true;
  }

  return false;
}
