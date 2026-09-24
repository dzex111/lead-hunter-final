import { describe, expect, it } from 'vitest';
import { allocateQueryBudget, newQueryStats, retireDeadQueries, updateQueryPosterior, type QueryStats } from '@/core/math/bandit';
import { diversityDistance, diversityReport, mmrRank, selectDailyBatch, type BatchCandidate } from '@/core/math/mmr';
import {
  DEFAULT_CONTACT_POLICY,
  cusumReplyRate,
  dailyCapFor,
  evaluateContactPolicy,
  isFridayBlackout,
  isQuietHours,
  markThrottleAfterBlocked,
  recordSend,
  warmupCurve,
} from '@/core/policy/contact';
import { ALLOWED_TRANSITIONS, assertTransition, canTransition, nextStageFromOutcome } from '@/core/lifecycle/state';
import { FakeClock } from '@/core/clock';
import { createRng } from '@/core/random';
import type { ContactPolicyInput, SenderState } from '@/core/types';

describe('query bandit', () => {
  it('allocates within provider budgets', () => {
    const stats: QueryStats[] = [
      newQueryStats('q1', 'brave'),
      newQueryStats('q2', 'brave'),
      newQueryStats('q3', 'google_cse'),
    ];
    const allocation = allocateQueryBudget(stats, {
      totalBudget: 10,
      perProviderBudget: { brave: 4, google_cse: 3 },
      rng: createRng(5),
    });
    expect(allocation).toHaveLength(7);
    expect(allocation.filter((entry) => entry.provider === 'brave')).toHaveLength(4);
    expect(allocation.filter((entry) => entry.provider === 'google_cse')).toHaveLength(3);
  });

  it('retires dead queries and keeps producers alive', () => {
    // 100 calls, zero qualified leads ⇒ Wilson upper bound is far below the floor.
    const dead: QueryStats = {
      ...newQueryStats('dead', 'brave'),
      calls: 100,
      newQualified: 0,
      alpha: 1,
      beta: 101,
      lastRunAt: new Date('2026-01-04T00:00:00.000Z'),
    };
    const good = updateQueryPosterior({ ...newQueryStats('good', 'brave') }, 10, 24);
    const { retired, active } = retireDeadQueries([dead, good]);
    expect(retired.map((entry) => entry.query)).toContain('dead');
    expect(active.map((entry) => entry.query)).toContain('good');
  });

  it('has sublinear regret versus uniform allocation in simulation', () => {
    const trueRates = [0.04, 0.08, 0.16, 0.3, 0.42];
    const best = Math.max(...trueRates);
    let banditRegret = 0;
    let uniformRegret = 0;
    const earlyBandit: number[] = [];
    const lateBandit: number[] = [];
    const rng = createRng(99);
    const posteriors = trueRates.map(() => ({ alpha: 1, beta: 1 }));
    const rounds = 2000;

    for (let round = 0; round < rounds; round += 1) {
      let chosen = 0;
      let bestSample = -1;
      posteriors.forEach((posterior, index) => {
        const sample = rng.beta(posterior.alpha, posterior.beta);
        if (sample > bestSample) {
          bestSample = sample;
          chosen = index;
        }
      });
      const reward = rng.next() < (trueRates[chosen] ?? 0) ? 1 : 0;
      const posterior = posteriors[chosen];
      if (posterior) {
        if (reward === 1) posterior.alpha += 1;
        else posterior.beta += 1;
      }
      const regret = best - (trueRates[chosen] ?? 0);
      banditRegret += regret;
      if (round < rounds / 2) earlyBandit.push(regret);
      else lateBandit.push(regret);

      const uniformPick = rng.int(trueRates.length);
      uniformRegret += best - (trueRates[uniformPick] ?? 0);
    }

    const earlyAvg = earlyBandit.reduce((acc, value) => acc + value, 0) / earlyBandit.length;
    const lateAvg = lateBandit.reduce((acc, value) => acc + value, 0) / lateBandit.length;
    expect(banditRegret).toBeLessThan(uniformRegret);
    expect(lateAvg).toBeLessThan(earlyAvg); // regret per round shrinks ⇒ sublinear total regret
  });
});

describe('daily batch selection (MMR + exploration quota)', () => {
  const candidates: BatchCandidate[] = [
    { id: 'a', score: 0.9, platform: 'shopify', category: 'fashion', wilaya: 'Alger', sampledP: 0.2 },
    { id: 'b', score: 0.88, platform: 'shopify', category: 'fashion', wilaya: 'Alger', sampledP: 0.21 },
    { id: 'c', score: 0.87, platform: 'shopify', category: 'fashion', wilaya: 'Alger', sampledP: 0.22 },
    { id: 'd', score: 0.86, platform: 'youcan', category: 'beauty', wilaya: 'Oran', sampledP: 0.19 },
    { id: 'e', score: 0.85, platform: 'woocommerce', category: 'kids', wilaya: 'Constantine', sampledP: 0.18 },
    { id: 'f', score: 0.84, platform: 'lightfunnels', category: 'auto', wilaya: 'Sétif', sampledP: 0.5 },
    { id: 'g', score: 0.83, platform: 'custom', category: 'electronics', wilaya: 'Batna', sampledP: 0.15 },
  ];

  it('reduces redundancy: distance is 0 within a clone group and 1 across all dimensions', () => {
    const a = candidates[0]!;
    const b = candidates[1]!;
    const d = candidates[3]!;
    expect(diversityDistance(a, b)).toBe(0);
    expect(diversityDistance(a, d)).toBe(1);
  });

  it('MMR beats top-N by score on diversity and honours lambda=1', () => {
    const mmr = mmrRank(candidates, { n: 5, lambda: 0.6, rng: createRng(1) });
    const topByScore = [...candidates].sort((x, y) => y.score - x.score).slice(0, 5);
    expect(diversityReport(mmr).meanPairwiseDistance).toBeGreaterThan(
      diversityReport(topByScore).meanPairwiseDistance,
    );
    const pureRelevance = mmrRank(candidates, { n: 3, lambda: 1, rng: createRng(1) }).map((item) => item.id);
    expect(pureRelevance).toEqual(['a', 'b', 'c']);
  });

  it('fills the 10% exploration quota from the sampled posterior', () => {
    const clones: BatchCandidate[] = Array.from({ length: 11 }, (_value, index) => ({
      id: `clone-${index}`,
      score: 0.9 - index * 0.001,
      platform: 'shopify',
      category: 'fashion',
      wilaya: 'Alger',
      sampledP: 0.1,
    }));
    const explorer: BatchCandidate = {
      id: 'explorer',
      score: 0.2,
      platform: 'woocommerce',
      category: 'kids',
      wilaya: 'Oran',
      sampledP: 0.9,
    };
    const batch = selectDailyBatch([...clones, explorer], {
      n: 8,
      lambda: 0.75,
      explorationRate: 0.1,
      rng: createRng(2),
    });
    expect(batch).toHaveLength(8);
    const exploration = batch.filter((item) => item.exploration);
    expect(exploration.map((item) => item.id)).toContain('explorer');
    expect(batch.filter((item) => !item.exploration).every((item) => item.platform === 'shopify')).toBe(true);
  });
});

describe('contact policy with a fake clock (time travel)', () => {
  const clock = new FakeClock('2026-01-05T10:00:00.000Z'); // Monday 11:00 Algiers
  const baseSender: SenderState = {
    startedAt: new Date('2025-12-01T09:00:00.000Z'),
    dailyCap: 40,
    platformCap: 6,
    sentByDay: {},
    sentByHour: {},
    lastSentAt: null,
    dailyReplyRates: [],
  };

  it('ramps the daily cap from 10 to the configured cap over 14 days', () => {
    const curve = warmupCurve(40);
    expect(curve[0]).toBe(10);
    expect(curve[7]).toBeGreaterThan(10);
    expect(curve[14]).toBe(40);
    const fresh = { ...baseSender, startedAt: clock.now() };
    expect(dailyCapFor(fresh, clock.now())).toBe(10);
    expect(dailyCapFor(baseSender, clock.now())).toBe(40);
  });

  it('halves the cap for 7 days after a blocked/reported outcome', () => {
    const throttled = markThrottleAfterBlocked(baseSender, clock.now());
    expect(dailyCapFor(throttled, clock.now())).toBe(20);
    clock.advanceDays(8);
    expect(dailyCapFor(throttled, clock.now())).toBe(40);
    clock.set('2026-01-05T10:00:00.000Z');
  });

  it('enforces quiet hours and the Friday blackout in Algiers time', () => {
    const lateEvening = new Date('2026-01-05T22:30:00.000Z'); // 23:30 Algiers
    expect(isQuietHours(lateEvening)).toBe(true);
    const morning = new Date('2026-01-05T09:00:00.000Z'); // 10:00 Algiers
    expect(isQuietHours(morning)).toBe(false);
    const fridayPrayer = new Date('2026-01-02T12:00:00.000Z'); // Friday 13:00 Algiers
    expect(isFridayBlackout(fridayPrayer)).toBe(true);
    expect(isFridayBlackout(new Date('2026-01-02T08:00:00.000Z'))).toBe(false);
    expect(isFridayBlackout(morning)).toBe(false);
  });

  it('allows exactly one first message and one follow-up after 3 days', () => {
    const monday = new Date('2026-01-05T10:00:00.000Z');
    const author: ContactPolicyInput = {
      leadId: 'lead-1',
      channel: 'whatsapp',
      history: [],
      now: monday,
      state: 'qualified',
      suppressed: false,
      onOrdelyCustomersList: false,
      senderState: baseSender,
    };
    expect(evaluateContactPolicy(author).allowed).toBe(true);

    const tooEarly: ContactPolicyInput = {
      ...author,
      history: [{ channel: 'whatsapp', stage: 'first_contact', occurredAt: new Date('2026-01-04T10:00:00.000Z') }],
    };
    const blocked = evaluateContactPolicy(tooEarly);
    expect(blocked.allowed).toBe(false);
    expect(blocked.code).toBe('followup_cooldown');
    expect(blocked.retryable).toBe(true);
    expect(blocked.nextAllowedAt?.toISOString()).toBe('2026-01-07T10:00:00.000Z');

    const afterThreeDays: ContactPolicyInput = {
      ...author,
      history: [{ channel: 'whatsapp', stage: 'first_contact', occurredAt: new Date('2026-01-01T10:00:00.000Z') }],
    };
    expect(evaluateContactPolicy(afterThreeDays).allowed).toBe(true);

    const exhausted: ContactPolicyInput = {
      ...author,
      history: [
        { channel: 'whatsapp', stage: 'first_contact', occurredAt: new Date('2025-12-20T10:00:00.000Z') },
        { channel: 'whatsapp', stage: 'followup', occurredAt: new Date('2025-12-25T10:00:00.000Z') },
      ],
    };
    expect(evaluateContactPolicy(exhausted).code).toBe('first_contact_limit');
    expect(evaluateContactPolicy(exhausted).retryable).toBe(false);
  });

  it('blocks a second channel inside 7 days and honours hard stops', () => {
    const monday = new Date('2026-01-05T10:00:00.000Z');
    const input: ContactPolicyInput = {
      leadId: 'lead-2',
      channel: 'instagram',
      history: [{ channel: 'whatsapp', stage: 'first_contact', occurredAt: new Date('2026-01-03T10:00:00.000Z') }],
      now: monday,
      state: 'sent',
      suppressed: false,
      onOrdelyCustomersList: false,
      senderState: baseSender,
    };
    expect(evaluateContactPolicy(input).code).toBe('channel_cooldown');
    expect(evaluateContactPolicy({ ...input, suppressed: true }).retryable).toBe(false);
    expect(evaluateContactPolicy({ ...input, onOrdelyCustomersList: true }).code).toBe('ordely_customer');
    expect(
      evaluateContactPolicy({
        ...input,
        history: [{ channel: 'instagram', stage: 'stop', occurredAt: new Date('2026-01-04T10:00:00.000Z') }],
      }).code,
    ).toBe('suppressed');
  });

  it('enforces daily/hourly caps, spacing and quiet hours', () => {
    const now = new Date('2026-01-05T10:00:00.000Z');
    const base: ContactPolicyInput = {
      leadId: 'lead-3',
      channel: 'whatsapp',
      history: [],
      now,
      state: 'qualified',
      suppressed: false,
      onOrdelyCustomersList: false,
      senderState: baseSender,
    };
    const capped = { ...baseSender, sentByDay: { '2026-01-05': 40 } };
    expect(evaluateContactPolicy({ ...base, senderState: capped }).code).toBe('daily_cap');
    const hourly = { ...baseSender, sentByHour: { '2026-01-05T11': 6 } };
    expect(evaluateContactPolicy({ ...base, senderState: hourly }).code).toBe('hourly_cap');
    const spacing = { ...baseSender, lastSentAt: new Date('2026-01-05T09:58:00.000Z') };
    expect(evaluateContactPolicy({ ...base, senderState: spacing }).code).toBe('spacing');
    expect(evaluateContactPolicy({ ...base, now: new Date('2026-01-05T22:30:00.000Z') }).code).toBe('quiet_hours');
  });

  it('records sends and detects a reply-rate drop with CUSUM', () => {
    const sent = recordSend(baseSender, new Date('2026-01-05T10:05:00.000Z'), 'whatsapp');
    expect(sent.sentByDay['2026-01-05']).toBe(1);
    expect(sent.sentByHour['2026-01-05T11']).toBe(1);

    const healthy = cusumReplyRate(
      [{ day: 'd1', sends: 20, replies: 3 }, { day: 'd2', sends: 20, replies: 4 }],
      0.12,
      DEFAULT_CONTACT_POLICY,
    );
    expect(healthy.alarm).toBe(false);
    const dropping = cusumReplyRate(
      [
        { day: 'd1', sends: 20, replies: 3 },
        { day: 'd2', sends: 20, replies: 0 },
        { day: 'd3', sends: 25, replies: 0 },
        { day: 'd4', sends: 25, replies: 1 },
        { day: 'd5', sends: 25, replies: 0 },
      ],
      0.12,
      DEFAULT_CONTACT_POLICY,
    );
    expect(dropping.alarm).toBe(true);
    expect(dropping.statistic).toBeGreaterThan(DEFAULT_CONTACT_POLICY.cusumThreshold);
  });
});

describe('lead lifecycle guards', () => {
  const ctx = {
    hasObservations: true,
    hasContactableChannel: true,
    qualified: true,
    suppressed: false,
    hasDraft: true,
    policyAllowed: true,
  };

  it('accepts every transition declared in the table and rejects the rest', () => {
    for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
      for (const to of targets) {
        const check = canTransition(from as never, to as never, ctx);
        expect(check.allowed).toBe(true);
      }
      expect(canTransition(from as never, 'paid' as never, ctx).allowed).toBe(
        from === 'paid' || from === 'activated' || (targets as string[]).includes('paid'),
      );
    }
    expect(canTransition('new', 'paid', ctx).allowed).toBe(false);
    expect(canTransition('new', 'drafted', ctx).allowed).toBe(false);
    expect(canTransition('do_not_contact', 'enriched', ctx).allowed).toBe(false);
  });

  it('enforces guards on enrich/qualify/draft/send', () => {
    expect(canTransition('new', 'enriched', { ...ctx, hasObservations: false }).allowed).toBe(false);
    expect(canTransition('enriched', 'qualified', { ...ctx, qualified: false }).allowed).toBe(false);
    expect(canTransition('enriched', 'qualified', { ...ctx, suppressed: true }).allowed).toBe(false);
    expect(canTransition('queued', 'drafted', { ...ctx, hasDraft: false }).allowed).toBe(false);
    expect(canTransition('drafted', 'sent', { ...ctx, policyAllowed: false }).allowed).toBe(false);
    expect(canTransition('sent', 'replied', ctx).allowed).toBe(true);
    expect(() => assertTransition('new', 'paid', ctx)).toThrow(/illegal lead transition/);
  });

  it('maps outcome stages onto lifecycle states', () => {
    expect(nextStageFromOutcome('contacted')).toBe('sent');
    expect(nextStageFromOutcome('replied')).toBe('replied');
    expect(nextStageFromOutcome('stop')).toBe('do_not_contact');
    expect(nextStageFromOutcome('blocked')).toBe('lost');
    expect(nextStageFromOutcome('unknown')).toBeNull();
  });
});
