# Lead Hunter — core engine for ORDELY (Algeria, COD merchants)

Headless lead engine that **discovers, enriches, classifies, scores and prepares
outreach** to Algerian cash-on-delivery merchants. It turns a messy stream of
merchant signals into a ranked daily queue where every lead already has a
rendered draft, an explanation and a `wa.me` link — the operator sends each
message manually in ~10 seconds.

> **The engine never sends.** No WhatsApp/Messenger/Instagram automation, no
> logged-in scraping, no fake accounts, no CAPTCHA bypass, no proxy rotation.
> It only prepares drafts and human handoff links. See `DECISIONS.md` §1.

It is intentionally independent from ORDELY: separate repo, separate database,
zero shared code (the only touchpoint is a read-only CSV exclusion list of
existing ORDELY customers).

---

## Quickstart

```bash
# 1. Postgres 16 (or use your own)
docker compose up -d

# 2. Environment
cp .env.example .env          # DATABASE_URL is the only required value

# 3. Install + schema
pnpm install
npx drizzle-kit push          # creates all 14 tables

# 4. Offline end-to-end demo (no network at all)
pnpm demo                     # ingest → enrich → resolve → score → queue → outcomes → refit

# 5. The ranked daily queue, with drafts + links + explanations
pnpm cli next --n 20
pnpm cli stats
pnpm cli sim run --sends 1000 # calibration / regret / uplift report
```

The console (`pnpm dev`, `/`) shows the same data read-only-plus-actions: KPIs,
funnel posteriors, model status, sender guardrails, the ranked queue with copy
buttons, the leads list with annotate / suppress / export / purge, and the query
bandit dashboard.

### CLI surface

```
pnpm cli sources                         # adapters, capabilities, feature-flag state
pnpm cli import paste --text "…"         # or: csv | social | ad-library | add
pnpm cli discover web_search --budget 25 --param url=… --dry-run
pnpm cli enrich --all --limit 25         # fetch → extract → classify → qualify
pnpm cli resolve                         # blocking → Fellegi-Sunter → merge/review
pnpm cli score --all --limit 50          # P(reply), funnel, EV, priority, UCB
pnpm cli next --n 20                     # ranked batch: draft + link + explanation
pnpm cli draft <leadId>                  # one draft
pnpm cli outcome <leadId> replied --note "ok for demo"
pnpm cli annotate <leadId> --key niche --value beauty
pnpm cli suppress <leadId|phone> --type lead --reason "asked to stop"
pnpm cli queries --budget 20             # Thompson allocation for today's API budget
pnpm cli stats --json                    # funnel, calibration, per-template, per-query
pnpm cli model refit                     # MAP refit + metrics (needs ≥ 30 outcomes)
pnpm cli export <leadId> --out lead.json # privacy: access request (Law 18-07)
pnpm cli purge --lead <leadId>           # privacy: erasure (keeps suppression)
pnpm cli purge --days 540                # retention purge
pnpm cli worker start                    # separate worker process
pnpm cli demo-seed --size 24             # seed the synthetic demo population
```

### Tests

```bash
pnpm test            # 89 tests (unit + property + fixtures)
pnpm test:coverage   # enforces ≥ 85% statements/lines on src/core
```

---

## Architecture

```mermaid
flowchart TB
  subgraph Sources["Discovery adapters (src/adapters/sources)"]
    MP[manual_paste] --- CSV[csv_import] --- SOC[social_paste] --- ADM[ad_library_manual]
    WS[web_search<br/>Brave · Google CSE · Serper: OFF] --- GP[google_places] --- MAL[meta_ad_library_api: OFF]
    CRAWL[site_crawl_expansion] --- DIR[directory_import] --- DEMO[demo_seed · synthetic]
  end

  Sources -->|RawCandidate + provenance + cost| ING[ingest<br/>leads · lead_identities · observations · audit_log]

  subgraph Fetch["Safe fetcher (src/adapters/http)"]
    SSRF[SSRF guard: DNS re-check per redirect] --- RB[robots.txt cache] --- TB[token bucket + circuit breaker]
  end

  ING --> ENR[enrich]
  ENR -->|GET via safe fetcher| Fetch
  Fetch --> EXTR["extract (pure)<br/>fingerprints · contacts · adtech · catalog<br/>market · language · category NB · maturity"]
  EXTR --> OBS[(observations append-only)]
  OBS --> QUA["qualify (hard gates + reasons)"]
  QUA --> RES["resolve (blocking → Fellegi-Sunter → union-find)"]
  RES --> MERGE[(merge_log reversible)]
  RES --> SCO["score (math engine)<br/>logistic MAP + Laplace → probit<br/>funnel Beta-Binomial → EV → priority → UCB"]
  SCO --> SC[(scores: features + contributions)]
  SCO --> POL["contact policy + sender protection<br/>caps · ramp · quiet hours · Friday · CUSUM"]
  POL --> DR[render draft + wa.me / m.me link]
  DR --> ATT[(outreach_attempts: drafted)]
  ATT -->|HUMAN sends manually| OUT["outcome <lead> <stage>"]
  OUT --> LEARN[(outcomes · template_variants · model_versions)]
  LEARN --> SCO
  LEARN --> JOBS[(jobs: SKIP LOCKED · leases · jitter · DLQ)]
  JOBS --> WORKER[worker process]
  CONSOLE[Operator console (Next.js)] <--> DB[(Postgres 16 · Drizzle)]
```

Pipeline: `discover → fetch → extract → classify → resolve → qualify → score →
draft → queue → outcome → learn`.

---

## Repository layout

```
src/core/            pure: normalize · extract · classify · math · policy · messaging · lifecycle · entity · qualify
src/adapters/        impure: http (safe fetcher) · sources (11 adapters) · db (schema repo) · queue · pipeline
src/cli/             commander CLI (+ integration commands)
src/worker/          separate worker process
src/sim/             synthetic population with hidden ground truth
src/demo/            offline end-to-end run
src/app/             operator console (Next.js App Router + API routes)
tests/               89 unit/property/fixture tests + real saved HTML fixtures
docs/MATH.md         formulas, priors table, rationale
docs/SOURCES.md      every external claim: URL, date, what was verified (and what was not)
DECISIONS.md         every assumption + dependency justification
```

## Data model (14 tables)

`leads` · `lead_identities` (UNIQUE(type, normalized_value)) · `observations`
(append-only: value, confidence, evidence[], source, observed_at, expires_at) ·
`scores` (model_version, features, per-feature contributions, probabilities, ev,
priority) · `templates` · `template_variants` · `outreach_attempts` · `outcomes`
· `suppression` · `jobs` · `search_queries` · `model_versions` · `merge_log`
(reversible) · `audit_log`, plus `sender_state` and `recurring_schedules`.

## What is flagged OFF, and why

| Feature | State | Reason |
|---|---|---|
| `meta_ad_library_api` | **OFF**, fails closed | Commercial (non-political) ad returnability for Algeria could not be verified from official docs. Compliant alternative shipped: `ad_library_manual` (operator pastes what the public Ad Library shows). |
| `serper` search provider | **OFF**, fails closed | Official Serper docs were unreachable during Phase 0 verification. Brave + Google CSE are implemented and on. |
| LLM category fallback | **OFF** | Deterministic naive-Bayes classifier is used; the flag exists so a strict-schema, cached LLM fallback can be enabled later. |
| HTML snapshot saving | **OFF** | Fixture-building only; the saved snapshots under `tests/fixtures/raw/` were captured deliberately, not at runtime. |
| Auto-send of any kind | **not implemented** | Blocked by design (rule #1). |

## Privacy (Algerian Law 18-07)

Only business-public contact data is stored. Global suppression is a hard stop
that also blocks re-enrichment; `export` implements access requests and
`purge --lead` implements erasure (keeping the suppression record so a
"do not contact" decision survives). `LEADHUNTER_RETENTION_DAYS` drives the
scheduled purge, and every state change is written to `audit_log`. See
`docs/SOURCES.md` §3 for the honest caveat: the legal text itself was not
fetched — confirm retention/declaration wording with counsel.
