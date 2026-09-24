/**
 * Per-domain polite fetching: token bucket, concurrency slot and circuit
 * breaker. All state is per-process and keyed by domain.
 */
export interface DomainPolicy {
  /** Sustained requests per second. */
  ratePerSecond: number;
  burst: number;
  maxConcurrency: number;
  circuitFailureThreshold: number;
  circuitCooldownMs: number;
}

export const DEFAULT_DOMAIN_POLICY: DomainPolicy = {
  ratePerSecond: 0.5,
  burst: 2,
  maxConcurrency: 1,
  circuitFailureThreshold: 5,
  circuitCooldownMs: 10 * 60_000,
};

interface BucketState {
  tokens: number;
  lastRefill: number;
  inFlight: number;
  consecutiveFailures: number;
  circuitOpenUntil: number;
  totalRequests: number;
  totalFailures: number;
}

export class CircuitOpenError extends Error {
  readonly domain: string;
  readonly retryAt: Date;

  constructor(domain: string, retryAt: Date) {
    super(`circuit open for ${domain} until ${retryAt.toISOString()}`);
    this.name = 'CircuitOpenError';
    this.domain = domain;
    this.retryAt = retryAt;
  }
}

export class DomainLimiter {
  private readonly state = new Map<string, BucketState>();
  private readonly policy: DomainPolicy;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    policy: Partial<DomainPolicy> = {},
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.policy = { ...DEFAULT_DOMAIN_POLICY, ...policy };
    this.sleep = sleep;
  }

  private stateFor(domain: string): BucketState {
    const existing = this.state.get(domain);
    if (existing) return existing;
    const created: BucketState = {
      tokens: this.policy.burst,
      lastRefill: Date.now(),
      inFlight: 0,
      consecutiveFailures: 0,
      circuitOpenUntil: 0,
      totalRequests: 0,
      totalFailures: 0,
    };
    this.state.set(domain, created);
    return created;
  }

  /** Waits for a token + concurrency slot; throws CircuitOpenError when open. */
  async acquire(domain: string, now: number = Date.now()): Promise<void> {
    const state = this.stateFor(domain);
    if (state.circuitOpenUntil > now) {
      throw new CircuitOpenError(domain, new Date(state.circuitOpenUntil));
    }
    // Concurrency gate (poll until a slot frees).
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (state.inFlight < this.policy.maxConcurrency) break;
      await this.sleep(250);
    }
    // Token bucket.
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const current = Date.now();
      const elapsed = (current - state.lastRefill) / 1000;
      state.tokens = Math.min(this.policy.burst, state.tokens + elapsed * this.policy.ratePerSecond);
      state.lastRefill = current;
      if (state.tokens >= 1) {
        state.tokens -= 1;
        break;
      }
      const waitMs = Math.max(50, ((1 - state.tokens) / this.policy.ratePerSecond) * 1000);
      await this.sleep(Math.min(waitMs, 5_000));
    }
    state.inFlight += 1;
    state.totalRequests += 1;
  }

  release(domain: string, outcome: { ok: boolean; now?: number }): void {
    const state = this.stateFor(domain);
    state.inFlight = Math.max(0, state.inFlight - 1);
    const now = outcome.now ?? Date.now();
    if (outcome.ok) {
      state.consecutiveFailures = 0;
      return;
    }
    state.consecutiveFailures += 1;
    state.totalFailures += 1;
    if (state.consecutiveFailures >= this.policy.circuitFailureThreshold) {
      state.circuitOpenUntil = now + this.policy.circuitCooldownMs;
      state.consecutiveFailures = 0;
    }
  }

  stats(domain: string): BucketState & { circuitOpen: boolean } {
    const state = this.stateFor(domain);
    return { ...state, circuitOpen: state.circuitOpenUntil > Date.now() };
  }

  isCircuitOpen(domain: string, now = Date.now()): boolean {
    return this.stateFor(domain).circuitOpenUntil > now;
  }

  reset(domain?: string): void {
    if (domain) this.state.delete(domain);
    else this.state.clear();
  }
}
