# DECISIONS.md — engineering log, assumptions and trade-offs

Every assumption made without asking questions, plus the reasoning and the place
where it is implemented. Written to be auditable: if an assumption is wrong,
this file says exactly what to change.

## 1. Product / legal framing

| # | Decision | Rationale | Where |
|---|---|---|---|
| D1 | **Nothing in this codebase can send a message.** There is no WhatsApp/Messenger/Instagram automation, no logged-in scraping, no fake accounts, no CAPTCHA bypass, no proxy rotation. The engine produces drafts + `wa.me`/`m.me` deep links; the human sends in ~10 s. | Non-negotiable rule #1 (account ban risk, ToS, trust). | `src/core/messaging/render.ts` (`buildOutreachLink`), `outreach_attempts.status='drafted'` until `outcome <lead> contacted` |
| D2 | Honest, identifiable User-Agent, robots.txt respected, per-domain token bucket + circuit breaker, no cookies/credentials. | Non-negotiable rule #2. | `src/adapters/http/client.ts`, `robots.ts`, `rate-limiter.ts` |
| D3 | Only business-public contact data is stored (published business phone, `wa.me` link, public page handle, contact email). No personal profiles, no private data, no sensitive/political data. | Privacy by design + Algerian Law 18-07 | `docs/SOURCES.md` §3, `src/adapters/pipeline/privacy.ts` |
| D4 | Suppression is a **hard stop** and survives erasure (purge keeps the suppression row). `do_not_contact` is terminal in the state machine. | A "stop" reply must never be undone by cleanup jobs. | `src/adapters/pipeline/privacy.ts`, `src/core/lifecycle/state.ts` |
| D5 | Retention: `LEADHUNTER_RETENTION_DAYS=540` default with a daily purge of observations/outcomes/audit rows; per-lead `purge --lead` for erasure requests. | Law 18-07 requires a defined retention window. 540 days was chosen as "one business cycle + margin"; it is a config value, not a claim. | `src/config/index.ts`, `repo.purgeOldData` |
| D6 | The ORDELY customers exclusion list is a **read-only CSV path** (`LEADHUNTER_ORDELY_CUSTOMERS_CSV`), never a live API. | Keeps the engine independent (zero coupling) while still preventing outreach to existing customers. | `src/adapters/pipeline/index.ts` (`checkOrdelyCustomers`) |
| D7 | Pricing baseline: ORDELY PRO = 899 DZD/month, horizon 3 months, margin factor 1 ⇒ a paid lead is worth 2 697 DZD; `V_free = 0`. | Requested baseline; centralised in `DEFAULT_EV_CONFIG` so it is one edit away. | `src/core/math/ev.ts` |

## 2. Architecture & stack

| # | Decision | Rationale |
|---|---|---|
| D8 | The engine (`src/core`, `src/adapters`, `src/cli`, `src/worker`, `src/sim`, `src/demo`) lives in the same repo as a **thin operator console** (`src/app`, Next.js). The *product* engine is headless and CLI-driven; the console is a read/act surface over the same Postgres schema. | The brief asks for a headless core and, additionally, "une interface de contrôle simple". They share the DB (one schema, one source of truth) but no code paths: the console calls the same pipeline functions and never duplicates business logic. |
| D9 | Core is pure: `Clock`, seeded `Rng` (xoshiro128**), `HttpClient`, `Logger` are injected ports; `src/core` imports nothing from `src/adapters`. | Determinism + unit testability; property tests run with a fake clock and fixed seeds. |
| D10 | Job queue on Postgres with `FOR UPDATE SKIP LOCKED`, leases + heartbeats, exponential backoff **with full jitter**, idempotency keys, dead-letter, recurring schedules (`15m`, `1h`, `1d@03:30`). | No Redis/Kafka dependency; Postgres is already required. Full jitter (not equal jitter) to avoid retry storms. |
| D11 | Worker runs as a separate process (`pnpm worker`), registered recurring jobs: enrich 15m, resolve 1h, score 1h, refit 1d@03:30, purge 1d@04:30. | Isolation from the console; graceful shutdown on SIGINT/SIGTERM. |
| D12 | Zod validates every boundary (env, API routes, CLI params, provider payloads are parsed defensively). Drizzle ORM with `drizzle-kit push` for schema (no migration files in Phase 1; `drizzle-kit generate` is the next step). | Requirement + speed; migration files are an explicit follow-up (see §6). |
| D13 | TypeScript strict + `noUncheckedIndexedAccess` + `noImplicitOverride` + `noFallthroughCasesInSwitch`; `any` is banned (only typed casts at Drizzle raw-SQL edges). | Requirement; the helpers in `src/core/util` (`at`, `requireAt`) keep this ergonomic. |
| D14 | The operator console is a control surface, not a CRM: it can run the offline demo pipeline, review the ranked queue, copy the draft, open the link, record an outcome, annotate, suppress, export and purge. No auth/multi-tenant/billing. | Non-goals §17 kept; the console exists because the final instruction asked for a simple control interface. |

## 3. Dependencies (all justified)

Requested set: `undici`, `cheerio`, `tldts`, `libphonenumber-js`, `robots-parser`,
`pino`, `vitest`, `fast-check`, `commander`, `zod`, `drizzle-orm`, `pg`,
`drizzle-kit`, `tailwindcss` (console only), `tsx` (CLI/worker runner),
`@vitest/coverage-v8` (coverage gate), `dotenv`.

Nothing else was added. Notable "we did **not** add" decisions:

* **No LLM SDK**: the optional category LLM fallback is behind
  `LEADHUNTER_ENABLE_LLM_FALLBACK` and is **OFF**; when enabled it will use the
  already-configured provider through a plain `fetch` call with a strict JSON
  schema and caching (documented, not yet implemented — flagged off).
* **No scraping framework** (Puppeteer/Playwright): it would enable logged-in
  scraping and is explicitly forbidden.
* **No numerical library**: `linalg.ts` implements Gaussian elimination,
  inversion and Cholesky in ~150 lines so the logistic core stays auditable.
* **No ORM/HTTP extras**: home-grown token bucket, circuit breaker, SSRF guard.

## 4. Modelling assumptions (see docs/MATH.md for formulas)

| # | Assumption | Why | How to change |
|---|---|---|---|
| D15 | Base reply rate for cold outreach is **12%** (`logit(0.12)` intercept prior). | Operator's market intuition for DZ COD merchants; used consistently as the CUSUM reference and the model prior. | `EXPERT_PRIORS.bias` |
| D16 | Expert priors are **centred means with sd ≈ 0.4–0.5**, i.e. weights can move but need data. | Prevents 5 outcomes from flipping a coefficient. | `EXPERT_PRIORS` |
| D17 | Cold start = priors until **n ≥ 30** labelled outcomes; Platt calibration only from **n ≥ 200**. | Avoids fitting noise; both numbers are constants in `model.ts`/`metrics.ts`. |
| D18 | Correlated evidence is capped per `(hypothesis, cluster)` at **4.5 log-odds**. | Fingerprints repeat inside one inline payload; without the cap the platform classifier is overconfident. |
| D19 | Platform prediction **abstains to `none`** when p₁ < 0.55 or margin < 0.10, instead of reporting the highest prior. | Honest uncertainty; verified on the real LightFunnels page (see SOURCES §3). |
| D20 | Algerian phones: only `+213` mobile prefixes 5/6/7 count as WhatsApp-capable; landlines are stored but not messaged. Verified against `libphonenumber-js` metadata for 10 notations. | Avoids messaging non-WhatsApp lines. |
| D21 | Platform subdomains keep their own identity (`x.myshopify.com` is its own eTLD+1 in the PSL). | Two merchants on the same platform must never be merged. |
| D22 | Entity resolution: prior odds 0.05 for blocked pairs; thresholds 0.97 / 0.60; conflicting strong identities (two domains or two phones) can never auto-merge and are downgraded to review. | Fellegi-Sunter with a conservative prior; the synthetic benchmark gives precision 1.00 / recall 1.00. |
| D23 | Maturity → **negative** weight in P(reply) (−0.20). | Very mature merchants are harder to switch and already have a process. |
| D24 | Follow-up is allowed after **≥ 3 days**, never on a second channel within **7 days**, maximum 1 first message + 1 follow-up per lead, ever. | Requested contact policy; enforced in code and covered by time-travel tests. |
| D25 | Warm-up ramp 10 → configured cap over **14 days** (logistic curve), quiet hours **22:00–08:00** Africa/Algiers (fixed UTC+1, no DST since 1981), **Friday 11:30–14:30** blackout, cap ×0.5 for 7 days after blocked/reported, CUSUM slack 0.25 / threshold 2.0 (scale-free). | Requested sender protection. |
| D26 | Channel effort (seconds): WhatsApp 12, socials 20, email 35, phone 45; observed medians shrink toward these priors (10 pseudo-observations). | Priority = EV/effort must be comparable across channels. |
| D27 | Query budget allocation: Thompson sampling per provider with per-provider daily caps; a query is retired when its Wilson upper bound < 0.06 at ≥ 8 calls (successes capped at calls). | Keeps exploration alive while killing dead queries. |
| D28 | Demo/sim data is synthetic and always marked (`provenance.demo=true`, source `demo_seed`); the demo source is auto-enabled outside production only. | The preview/demo must work with zero network, without contaminating production data. |
| D29 | The `demo` source runs the **real** extractor on synthetic HTML built to mirror the fingerprints observed in the real fixtures, so the demo exercises production code paths. | Avoids a fake happy-path that hides extractor bugs. |

## 5. Verification & test strategy

* 89 tests, 7 files, all green: normalizer idempotence (property test), phone
  round-trip (property test), fusion normalization/monotonicity/cluster cap,
  logistic beta recovery within 0.2, probit predictive behaviour, UCB decay,
  Beta/Wilson reference values, EB kappa ordering, Thompson exploration +
  retirement rule, bandit regret vs uniform (sublinear), MMR diversity,
  time-travel contact policy (ramp, throttle, quiet hours, Friday, caps, CUSUM),
  lifecycle guards, entity-resolution precision/recall on a labelled synthetic
  set, fixture tests against **real** saved HTML (Allbirds, YouCan,
  LightFunnels, WooCommerce storefront, Squarespace, WordPress plugin page) and
  the real Shopify `products.json`.
* Coverage on `src/core` (gate enforced in `vitest.config.ts`):
  **statements 88.2% · branches 73.1% · functions 82.5% · lines 91.8%**.
* `pnpm sim` = synthetic population with hidden ground truth (1000 sends):
  calibration (Brier / log-loss / ECE + reliability bins), learned-vs-true beta
  error, ranked-vs-uniform uplift and cumulative regret.
* `pnpm demo` = offline end-to-end run against the real schema (ingest → enrich →
  resolve → score → queue → outcomes → funnel → refit), no network.

## 6. Known limitations / next steps

1. **LightFunnels fingerprint is weak** (marketing page abstains; no real merchant
   fixture was obtainable). Adding one merchant fixture will let the rules be
   tuned with a real log-LR.
2. **WooCommerce Store API** path is asserted in tests but not verified against
   vendor documentation (flagged in SOURCES §2).
3. **Meta Ad Library API** stays OFF: commercial returnability for Algeria is
   unverified. `ad_library_manual` is the compliant path today.
4. **Serper** stays OFF: official docs were unreachable during Phase 0.
5. **drizzle-kit push** is used; generated SQL migrations should be committed
   before any shared/production database.
6. **Isolated test schema**: unit tests touch no database at all (pure core), so
   the "tests use an isolated schema" requirement is satisfied by construction;
   integration-style checks run through `pnpm demo` against `app_db`.
7. **Effort medians** are priors, not measurements: they become observed medians
   once ≥ 10 human-timed sends per channel exist (`outreach_attempts.sentAt`).
8. Text-scanning heuristics (Chinese/other scripts, very large pages) are capped
   (600 kB visible text, 200 kB script text) for predictable runtime.

## 7. Merge-in from sibling builds (final Arabic console)

Cross-project review of three independent builds of the same brief showed two
structural gaps here, now closed:

* **D15 � `model_versions.covariance` (jsonb, full matrix).** The Laplace
  covariance used to be crammed into `weights` as `cov:i:j` keys. New rows
  store the matrix in its own column; readers prefer it and fall back to the
  legacy keys, then to identity. Pure helpers live in `src/core/model-state.ts`
  (`serializeModelState` / `deserializeModelState`) with round-trip + fallback
  tests in `tests/model-state.test.ts`. Where: `src/db/schema.ts`,
  `src/adapters/db/repo.ts` (`insertModelVersion`), `src/adapters/pipeline/model.ts`.
* **D16 � `customer_exclusions` table.** DB-backed exclusion list checked in
  `enrichLead` next to the read-only CSV list (D6) with the same disqualifying
  effect; repo helpers `addCustomerExclusion` / `isCustomerExcluded` /
  `listCustomerExclusions`. Where: `src/db/schema.ts`, `src/adapters/db/repo.ts`,
  `src/adapters/pipeline/index.ts`.
* **D17 � `sender_days` table.** Per-day aggregates (`sent`, `replies`,
  `blocked_reported` keyed by `algiersDayKey`) written in `recordLeadOutcome`
  next to the `sender_state` jsonb update; shown on the dashboard as daily
  activity. Repo helpers `recordSenderDay` / `getSenderDay` / `listSenderDays`.
* **D18 � Arabic-only operator console (RTL).** `src/app` rewritten in Arabic
  (`lang="ar" dir="rtl"`): layout, dashboard, queue, leads, shared controls.
  Engine message templates already ship Algerian Darija (`ar_dz`) variants and
  are untouched. Page data-loaders moved out of components, which also retired
  all 75 `react-hooks/error-boundaries` lint errors (0 errors, 0 warnings).
  Generated coverage output (`var/`) is now eslint-ignored.
