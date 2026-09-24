# MATH.md — models, formulas, priors and rationale

All math lives in `src/core/math/` and `src/core/features.ts`, is log-space,
epsilon-clamped (`EPSILON = 1e-9`), NaN-proof (`safeProb`, `clamp`, clamped
Wilson) and property-tested in `tests/math.test.ts`, `tests/decision.test.ts`.

---

## 1. Evidence fusion (platform, market, category) — `math/fusion.ts`

Naive Bayes in log-odds space:

```
posterior_log_odds(h) = prior_log_odds(h) + Σ_e logLR_e(h)
logLR = log( P(e | h) / P(e | ¬h) )
P(h | e) = softmax over hypotheses (numerically stable softmax on log-odds)
```

*Correlated evidence* is handled by **clustering**: every fingerprint rule carries
a `clusterId`; contributions inside one `(hypothesis, cluster)` group are summed
and then **capped at `clusterCapLogLr = 4.5`** (≈ 99% confidence from one
cluster). Ten Shopify markers inside `window.Shopify` cannot outvote one decisive
`x-shopid` header.

Outputs: full posterior vector, `entropyBits = −Σ p log₂ p`, `margin = p₁ − p₂`,
`abstained = p₁ < 0.55 ∨ margin < 0.10`. If the posterior abstains, the platform
is reported as `none` — the engine never reports the *highest prior* as a
conclusion.

Parent/child correction: WooCommerce runs on WordPress, so WordPress evidence is
penalised by `logPenalty = −2.3` (≈ odds ÷ 10) when scoring WordPress itself.

Platform priors (`src/core/extract/fingerprints.ts`, share of DZ storefronts by
stack — operator estimate, replaceable data, not a claim about the market):

| platform | prior | platform | prior |
|---|---|---|---|
| shopify | 0.28 | wix | 0.05 |
| youcan | 0.09 | squarespace | 0.02 |
| woocommerce | 0.13 | webflow | 0.02 |
| wordpress | 0.04 | magento | 0.01 |
| prestashop | 0.03 | salla / zid | 0.01 each |
| lightfunnels | 0.06 | custom | 0.17 |
| | | none | 0.08 |

`custom` may only win if its own log-LR sum ≥ `CUSTOM_MIN_LOG_LR = 2.0`
(real storefront evidence: cart/checkout/COD form).

---

## 2. Market & maturity

### 2.1 P(Algeria) — `core/extract/market.ts`

Log-odds prior `logit(0.12)`, then additive evidence:

| evidence | log-odds |
|---|---|
| `.dz` TLD | +1.7 |
| COD phrases (sum of per-phrase weights, capped) | ≤ +4.0 |
| DZD / DA / دج currency | +2.1 |
| ≥ 5 wilaya names / 2–4 wilaya names | +1.1…2.6 / +0.9 |
| ≥ 2 / 1 DZ phone(s) | +2.4 / +1.8 |
| Darija / MSA / French dominant | +1.2 / +0.6 / +0.4 |

### 2.2 P(sells physical goods online)

`logit(0.20)`, plus `min(3.4, 0.9 + ln(1+products)/2.2)` for an enumerated
catalogue, `+1.3` cart, `+1.1` checkout, `+0.9` prices, `+1.2` COD phrases,
`+0.8` DZD.

### 2.3 Maturity index (0–100) — `core/classify/maturity.ts`

```
maturity = 100 · ( 0.30·catalog + 0.20·freshness + 0.20·tracking + 0.15·channels + 0.15·stack )
catalog   = clip( ln(1+productCount) / ln(301), 0, 1 )
freshness = 2^(−daysSinceLastProductUpdate / 30)      (30-day half-life; 0.35 if unknown)
tracking  = clip(pixelCount/4, 0, 1) · (serverSidePixel ? 1 : 0.85)
channels  = clip(distinctContactChannels/4, 0, 1)
stack     = platform sophistication table (shopify 1.0 … none 0.2)
```

---

## 3. P(reply): Bayesian logistic regression — `math/logistic.ts`, `core/features.ts`

MAP estimation with a Gaussian prior per coefficient (mean `m_j`, sd `s_j`):

```
ℓ(β) = Σ_i [ y_i log p_i + (1−y_i) log(1−p_i) ] − ½ Σ_j ((β_j − m_j)/s_j)²
Newton/IRLS step:  β ← β + H⁻¹ g ,  H = XᵀWX + diag(1/s_j²) ,  g = Xᵀ(y−p) − diag(1/s_j²)(β−m)
                  W = diag(p_i(1−p_i))            (backtracking line search, ≥ 1e−6 jitter)
Laplace covariance: Σ ≈ H⁻¹
Predictive probability (probit approximation): p = σ( μ / √(1 + π·s²/8) ),  μ = xᵀβ ,  s² = xᵀΣx
UCB:  kappa_t = kappa₀ / √(1 + n/n₀) ,  UCB = p + kappa_t·s      (kappa₀ = 1, n₀ = 30)
```

*Cold start*: priors only until **n ≥ 30** labelled outcomes.
*Calibration*: Platt scaling is only enabled from **n ≥ 200** (`CALIBRATION_MIN_SAMPLES`).
Metrics recorded per model version: Brier, log-loss, ECE (10 bins), AUC, positive
rate, iterations, convergence flag.

### 3.1 Feature transforms and expert priors (intercept encodes a 12% base reply rate: `logit(0.12) = −1.99`)

| feature | transform | prior mean | sd | rationale |
|---|---|---|---|---|
| `bias` | 1 | −2.00 | 1.0 | cold-outreach base rate 12% |
| `is_advertiser_fresh` | `2^(−Δt_days/21)` | 0.55 | 0.5 | paying for traffic ⇒ aware of unit economics; 21-day half-life |
| `log_ad_count` | `ln(1+ads)` | 0.10 | 0.35 | volume of creatives = testing culture |
| `sells_cod` | 0/1 | 0.85 | 0.5 | COD = exactly the ORDELY pain |
| `has_direct_whatsapp` | 0/1 | 0.60 | 0.5 | WhatsApp already the channel |
| `has_messenger_or_ig` | 0/1 | 0.15 | 0.4 | DM-only merchants answer less on WhatsApp |
| `platform_shopify` | 0/1 | 0.15 | 0.4 | already pays a SaaS, 2 platforms comparison |
| `platform_youcan` | 0/1 | 0.30 | 0.5 | DZ-local platform, closest ICP |
| `platform_woocommerce` | 0/1 | 0.05 | 0.4 | self-hosted, price sensitive |
| `platform_other` | 0/1 | 0.00 | 0.4 | baseline |
| `category_fashion` | 0/1 | 0.20 | 0.4 | high return rate ⇒ anti-return value |
| `category_beauty` | 0/1 | 0.25 | 0.4 | hero vertical for COD |
| `category_phones` | 0/1 | 0.10 | 0.4 | accessory margins |
| `category_other` | 0/1 | 0.00 | 0.4 | baseline |
| `maturity_index` | /100 | −0.20 | 0.4 | very mature merchants are harder to switch |
| `log_catalog_size` | `clip(ln(1+n)/ln(301),0,1)` | 0.20 | 0.35 | real operational pain needs volume |
| `pixel_meta` | 0/1 | 0.35 | 0.4 | Meta pixel ⇒ doing CAPI-confirmable ads |
| `pixel_tiktok` | 0/1 | 0.25 | 0.4 | second channel sophistication |
| `language_arabic` | 0/1 (`ar_msa`/`ar_dz`) | 0.30 | 0.4 | Darija/arabic merchants reply in Arabic |
| `language_french` | 0/1 (`fr`) | −0.10 | 0.4 | French-first merchants reply less often |
| `channel_whatsapp` | 0/1 | 0.50 | 0.5 | wa.me pre-filled message, 12 s effort |
| `channel_social` | 0/1 | −0.25 | 0.4 | DM requests are ignored more (no prefill) |
| `hour_afternoon` | Algiers 11:00–16:00 | 0.10 | 0.3 | afternoon responsiveness |
| `hour_evening` | Algiers 16:00–22:00 | 0.05 | 0.3 | evening responsiveness |
| `sender_warmup` | 0…1 | −0.30 | 0.4 | during warm-up the account is new/untrusted |

---

## 4. Expected value and priority — `math/ev.ts`

```
EV = p_reply · p_interested|reply · p_signup|interested · p_activate|signup
     · [ p_paid|activate · V_paid·margin·H + (1 − p_paid|activate) · V_free ]
priority = EV / E[effort_seconds]
```

Baseline economics (config, not hard-coded): **V_paid = 899 DZD/month (ORDELY
PRO)**, `V_free = 0`, `marginFactor = 1`, `horizonMonths = 3` ⇒ a paid customer is
worth 2 697 DZD. Effort per channel (seconds) with shrinkage of the observed
median toward the prior (10 pseudo-observations):
whatsapp 12 · instagram/facebook/messenger 20 · tiktok 25 · email 35 · phone 45.

Example: `p_reply = 0.12`, `interested|reply = 0.5`, `signup|interested = 0.4`,
`activate|signup = 0.6`, `paid|activate = 0.3`, WhatsApp ⇒
`EV = 0.12·0.5·0.4·0.6·(0.3·2697) = 11.65 DZD`, `priority = 0.97 DZD/s`.

---

## 5. Funnel — Beta-Binomial with hierarchical partial pooling — `adapters/pipeline/funnel.ts`

Stages: `contacted → replied → interested → signed_up → activated → paid`.

```
per segment s (platform × category × channel):  Beta(α_s, β_s)
global rate p̂ = Σs / Σn
empirical-Bayes kappa (method of moments):
   Var_between = Var(segment rates) − p̂(1−p̂)/n̄         (0 if ≤ 0)
   kappa = p̂(1−p̂) / Var_between − 1                     (clamped ≥ 0)
partial pooling:  α = kappa·p̂ + s + 0.5 ,  β = kappa·(1−p̂) + (n−s) + 0.5
posterior mean = α/(α+β) , lower 95% = Beta⁻¹(0.05; α, β)  (regularized incomplete beta)
Wilson score interval is reported next to it as a flat (non-hierarchical) reference.
```

Reporting both the posterior mean and the 95% lower bound makes thin segments
visibly uncertain instead of falsely precise.

---

## 6. Daily batch selection — `math/mmr.ts`

Greedy **MMR** over the (platform, category, wilaya) simplex:

```
diversity(a,b) = ⅓ · [platform differs] + ⅓ · [category differs] + ⅓ · [wilaya differs]
argmax_c  λ·score(c) − (1−λ)·max_{s∈S} (1 − diversity(c,s))      λ = 0.75
```

plus an **exploration quota of 10%** of the batch filled by Thompson-sampling the
logistic posterior (`sampledP`, one draw per lead). Exploitation slots are capped
so the quota is always filled (a thin queue still explores).

---

## 7. Template/variant selection — `math/beta.ts`, `core/messaging/render.ts`

Thompson sampling on `Beta(a₀ + s, b₀ + f)`, contextual with hierarchical
shrinkage: `mean = (s + 2·globalMean) / (s + f + 2)`. Exploration floor 10%.
A variant is **retired** only when `Wilson_upper(variant) < Wilson_lower(baseline)`
at `n ≥ 40`, and retirement is flagged (`retireFlaggedForApproval`) for human
approval — the engine never silently kills a variant.

---

## 8. Sender protection — `core/policy/contact.ts`

```
warm-up ramp (14 days, 10 → cap):  cap_t = 10 + (cap − 10) · clip((ramp(t) − ramp(0))/(1 − ramp(0)), 0, 1)
                                   ramp(t) = 1 / (1 + e^(−10·(t/14 − 0.5)))
blocked/reported ⇒ cap × 0.5 for 7 days
hourly cap = platformCap (config), minimum spacing 4 min
quiet hours 22:00–08:00 Africa/Algiers (UTC+1, no DST), Friday 11:30–14:30 blackout
CUSUM on the reply rate (scale-free):  S_i = max(0, S_{i−1} + (target − observed)/target − slack)
                                       slack = 0.25, alarm when S > 2.0  ⇒ "possible throttling"
```

`target` is the expected reply rate (default 0.12, the same prior as the model).

---

## 9. Entity resolution — `core/entity/resolve.ts`

Fellegi-Sunter on blocked pairs, weights in log₂ space with `m`/`u` tables:
domain 0.545/0.004 · phone 0.396/0.0012 · whatsapp 0.356/0.0016 · email 0.297/0.0008 ·
handle 0.416/0.0022 · name 0.495/0.28 (Jaro-Winkler ≥ 0.90 or token-set ≥ 0.85) ·
wilaya 0.55/0.16 · category 0.60/0.20. Prior odds 0.05 (blocked pairs are
suspicious by construction).

```
posterior = σ( ln(prior_odds) + logWeight·ln 2 )
≥ 0.97 auto-merge · 0.60–0.97 review queue · < 0.60 distinct
conflicting strong identities (two domains, two phones) ⇒ NEVER auto-merge: a
posterior ≥ 0.97 is downgraded to the review queue.
```

Synthetic labelled benchmark: `tests/entity.test.ts` — 20 duplicate pairs + 20
unrelated merchants, precision ≥ 0.95, recall ≥ 0.90 (measured: 1.00 / 1.00).

---

## 10. Query bandit — `math/bandit.ts`

Each generated search query keeps `calls` and `newQualified`; reward
`r = newQualified / yieldPerCallTarget`, posterior `Beta(1 + Σr, 1 + Σ(calls − r))`.
Daily budget allocation: sequential Thompson sampling with per-provider budgets.
Retirement: `Wilson_upper(newQualified, calls) < 0.06` at `calls ≥ 8`
(successes are capped at calls, so a query cannot be "more than 100% correct").
Simulated regret is sublinear and beats uniform allocation
(`tests/decision.test.ts`, `pnpm sim`).

---

## 11. Simulation report (`pnpm sim`)

Synthetic population with hidden ground-truth coefficients (`TRUE_BETA` in
`src/sim/run.ts`), cold start → refit every 50 sends → final report: Brier,
log-loss, ECE + reliability bins, `mean|β_learned − β_true|`, ranked-vs-uniform
uplift and cumulative regret.
