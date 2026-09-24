import { z } from 'zod';

/**
 * Single configuration boundary. Everything is read from process.env once,
 * validated with Zod, and injected downward — core modules never touch env.
 */
const booleanish = z
  .string()
  .optional()
  .transform((value) => value === '1' || value?.toLowerCase() === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  LEADHUNTER_SEED: z.coerce.number().int().default(20260101),
  LEADHUNTER_OPERATOR: z.string().default('operator'),
  LEADHUNTER_USER_AGENT: z
    .string()
    .default('LeadHunterBot/0.1 (+https://ordely.example/lead-hunter; contact: operator@ordely.example)'),
  LEADHUNTER_RETENTION_DAYS: z.coerce.number().int().min(7).default(540),
  LEADHUNTER_DAILY_SEND_CAP: z.coerce.number().int().min(1).default(40),
  LEADHUNTER_HOURLY_SEND_CAP: z.coerce.number().int().min(1).default(6),
  LEADHUNTER_ORDELY_URL: z.string().default('https://app.ordely.example/signup'),
  /** Read-only CSV path keeping ORDELY customers out of outreach (no coupling). */
  LEADHUNTER_ORDELY_CUSTOMERS_CSV: z.string().optional(),
  LEADHUNTER_FETCH_RATE_PER_SECOND: z.coerce.number().positive().default(0.5),
  LEADHUNTER_FETCH_CONCURRENCY_PER_DOMAIN: z.coerce.number().int().min(1).default(1),
  LEADHUNTER_FETCH_MAX_BYTES: z.coerce.number().int().min(1024).default(2 * 1024 * 1024),
  LEADHUNTER_PROVIDER_BUDGET_SERPER: z.coerce.number().int().min(0).default(0),
  LEADHUNTER_PROVIDER_BUDGET_BRAVE: z.coerce.number().int().min(0).default(0),
  LEADHUNTER_PROVIDER_BUDGET_GOOGLE_CSE: z.coerce.number().int().min(0).default(0),
  LEADHUNTER_PROVIDER_BUDGET_GOOGLE_PLACES: z.coerce.number().int().min(0).default(0),

  // Provider credentials (all optional — adapters fail closed without them).
  SERPER_API_KEY: z.string().optional(),
  BRAVE_API_KEY: z.string().optional(),
  GOOGLE_CSE_KEY: z.string().optional(),
  GOOGLE_CSE_CX: z.string().optional(),
  GOOGLE_PLACES_API_KEY: z.string().optional(),
  META_AD_LIBRARY_TOKEN: z.string().optional(),

  // Explicit opt-ins for sources whose semantics are risky or unverified.
  LEADHUNTER_ENABLE_SERPER: booleanish,
  LEADHUNTER_ENABLE_META_AD_LIBRARY: booleanish,
  LEADHUNTER_ENABLE_LLM_FALLBACK: booleanish,
  LEADHUNTER_SAVE_SNAPSHOTS: booleanish,
  LEADHUNTER_ENABLE_DEMO_SOURCE: booleanish,
  OPENAI_API_KEY: z.string().optional(),
});

export interface ProviderBudget {
  dailyUnits: number;
}

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  databaseUrl: string;
  seed: number;
  operator: string;
  userAgent: string;
  retentionDays: number;
  ordelySignupUrl: string;
  ordelyCustomersCsv: string | null;
  fetch: {
    ratePerSecond: number;
    concurrencyPerDomain: number;
    maxBytes: number;
    timeoutMs: number;
    maxRedirects: number;
    contentTypeAllowlist: string[];
  };
  budgets: Record<'serper' | 'brave' | 'google_cse' | 'google_places', ProviderBudget>;
  sender: {
    dailyCap: number;
    hourlyCap: number;
  };
  providers: {
    serperApiKey: string | null;
    braveApiKey: string | null;
    googleCseKey: string | null;
    googleCseCx: string | null;
    googlePlacesApiKey: string | null;
    metaAdLibraryToken: string | null;
    openAiApiKey: string | null;
  };
  flags: {
    /** Verified against the docs feed; disabled by default, fails closed. */
    serper: boolean;
    metaAdLibraryApi: boolean;
    llmCategoryFallback: boolean;
    saveHtmlSnapshots: boolean;
    /** Synthetic source used only for offline demo/preview; never auto-enabled in prod. */
    demoSource: boolean;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`invalid environment configuration: ${issues.join('; ')}`);
  }
  const value = parsed.data;
  return {
    nodeEnv: value.NODE_ENV,
    databaseUrl: value.DATABASE_URL,
    seed: value.LEADHUNTER_SEED,
    operator: value.LEADHUNTER_OPERATOR,
    userAgent: value.LEADHUNTER_USER_AGENT,
    retentionDays: value.LEADHUNTER_RETENTION_DAYS,
    ordelySignupUrl: value.LEADHUNTER_ORDELY_URL,
    ordelyCustomersCsv: value.LEADHUNTER_ORDELY_CUSTOMERS_CSV ?? null,
    fetch: {
      ratePerSecond: value.LEADHUNTER_FETCH_RATE_PER_SECOND,
      concurrencyPerDomain: value.LEADHUNTER_FETCH_CONCURRENCY_PER_DOMAIN,
      maxBytes: value.LEADHUNTER_FETCH_MAX_BYTES,
      timeoutMs: 15_000,
      maxRedirects: 5,
      contentTypeAllowlist: ['text/html', 'application/json', 'application/xml', 'text/xml', 'text/plain', 'application/xhtml+xml'],
    },
    budgets: {
      serper: { dailyUnits: value.LEADHUNTER_PROVIDER_BUDGET_SERPER },
      brave: { dailyUnits: value.LEADHUNTER_PROVIDER_BUDGET_BRAVE },
      google_cse: { dailyUnits: value.LEADHUNTER_PROVIDER_BUDGET_GOOGLE_CSE },
      google_places: { dailyUnits: value.LEADHUNTER_PROVIDER_BUDGET_GOOGLE_PLACES },
    },
    sender: {
      dailyCap: value.LEADHUNTER_DAILY_SEND_CAP,
      hourlyCap: value.LEADHUNTER_HOURLY_SEND_CAP,
    },
    providers: {
      serperApiKey: value.SERPER_API_KEY ?? null,
      braveApiKey: value.BRAVE_API_KEY ?? null,
      googleCseKey: value.GOOGLE_CSE_KEY ?? null,
      googleCseCx: value.GOOGLE_CSE_CX ?? null,
      googlePlacesApiKey: value.GOOGLE_PLACES_API_KEY ?? null,
      metaAdLibraryToken: value.META_AD_LIBRARY_TOKEN ?? null,
      openAiApiKey: value.OPENAI_API_KEY ?? null,
    },
    flags: {
      serper: value.LEADHUNTER_ENABLE_SERPER === true && (value.SERPER_API_KEY ?? '').length > 0,
      metaAdLibraryApi:
        value.LEADHUNTER_ENABLE_META_AD_LIBRARY === true && (value.META_AD_LIBRARY_TOKEN ?? '').length > 0,
      llmCategoryFallback:
        value.LEADHUNTER_ENABLE_LLM_FALLBACK === true && (value.OPENAI_API_KEY ?? '').length > 0,
      saveHtmlSnapshots: value.LEADHUNTER_SAVE_SNAPSHOTS === true,
      demoSource:
        value.LEADHUNTER_ENABLE_DEMO_SOURCE === true || value.NODE_ENV !== 'production',
    },
  };
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!cached) cached = loadConfig(process.env);
  return cached;
}

export function resetConfigCache(): void {
  cached = null;
}
