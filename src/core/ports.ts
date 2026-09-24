/**
 * Ports (interfaces) the pure core depends on. Adapters in src/adapters
 * implement them; tests inject fakes. Nothing in src/core imports adapters.
 */
export interface HttpRequestSpec {
  url: string;
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  /** Caller-provided idempotency scope used for conditional GET caching. */
  purpose?: string;
}

export interface HttpResponseMeta {
  status: number;
  finalUrl: string;
  contentType: string | null;
  bytes: number;
  contentHash: string;
  fetchedAt: string;
  fromCache: boolean;
  redirects: number;
  robotsAllowed: boolean;
  domain: string;
  /** Actual cost accounting for provider budgets. */
  costUnits: number;
}

export interface HttpResponse {
  meta: HttpResponseMeta;
  body: string;
  headers: Record<string, string>;
}

export interface HttpClient {
  fetch(req: HttpRequestSpec): Promise<HttpResponse>;
  /** Optional snapshot saving for fixture building (adapter-level feature flag). */
  saveSnapshot?(url: string, body: string): Promise<string | null>;
}

export interface Logger {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export const SILENT_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface BudgetGuard {
  /** Consumes budget units; returns false when the budget is exhausted. */
  consume(units: number): boolean;
  remaining(): number;
}
