import type { AppConfig } from '@/config';
import type { Clock } from '@/core/clock';
import type { BudgetGuard, HttpClient, Logger } from '@/core/ports';
import type { Rng } from '@/core/random';
import type { RawCandidate } from '@/core/types';

/**
 * Discovery adapter contract. Every adapter declares its capabilities, honours
 * the injected budget guard, supports `dryRun` and reports cost accounting.
 */
export interface SourceCapabilities {
  /** Adapter performs outbound network calls. */
  network: boolean;
  /** Adapter consumes a paid provider API. */
  paidApi: boolean;
  requiresCredentials: boolean;
  robotsRespect: boolean;
  costUnitsPerCall: number;
  note: string;
}

export interface DiscoveryContext {
  clock: Clock;
  rng: Rng;
  http: HttpClient;
  logger: Logger;
  config: AppConfig;
  budget: BudgetGuard;
  dryRun: boolean;
  /** Adapter-specific parameters coming from the CLI. */
  params: Record<string, string>;
}

export interface DiscoverySource {
  id: string;
  label: string;
  capabilities: SourceCapabilities;
  /** Throws when required credentials/verification are missing (fail closed). */
  ensureReady(ctx: DiscoveryContext): void;
  discover(ctx: DiscoveryContext): AsyncIterable<RawCandidate>;
}

export class SourceNotReadyError extends Error {
  readonly sourceId: string;
  readonly hint: string;

  constructor(sourceId: string, hint: string) {
    super(`source ${sourceId} is not ready: ${hint}`);
    this.name = 'SourceNotReadyError';
    this.sourceId = sourceId;
    this.hint = hint;
  }
}

export class SimpleBudgetGuard implements BudgetGuard {
  private used = 0;

  constructor(private readonly limit: number) {}

  consume(units: number): boolean {
    if (this.used + units > this.limit) return false;
    this.used += units;
    return true;
  }

  remaining(): number {
    return Math.max(0, this.limit - this.used);
  }

  usedUnits(): number {
    return this.used;
  }
}

export function asAsyncIterable<T>(items: readonly T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}
