import { algiersDayKey, algiersHourKey, toAlgiersWallTime } from '@/core/clock';
import type { ChannelId, ContactPolicyInput, SenderState } from '@/core/types';
import { clamp, hoursBetween, minutesBetween, sigmoid } from '@/core/util';

/**
 * Contact policy + sender protection, all pure functions of (history, now, config).
 *
 *  - at most 1 first-contact message per lead, plus 1 follow-up after >= 3 days
 *  - never contact the same lead on two different channels within 7 days
 *  - hard stop on suppression / do_not_contact / ORDELY customers / stop replies
 *  - quiet hours 22:00-08:00 Africa/Algiers, Friday 11:30-14:30 blackout
 *  - daily cap with logistic warm-up ramp (10 → cap over 14 days)
 *  - halve the daily cap for 7 days after any blocked/reported outcome
 *  - CUSUM change detection on the daily reply rate
 */
export interface ContactPolicyConfig {
  followUpMinDays: number;
  channelCooldownDays: number;
  quietHourStart: number;
  quietHourEnd: number;
  fridayBlackoutStartMinutes: number;
  fridayBlackoutEndMinutes: number;
  minSpacingMinutes: number;
  warmupDays: number;
  warmupStartCap: number;
  blockedThrottleDays: number;
  blockedThrottleFactor: number;
  /** CUSUM alarm threshold, in units of "one target-rate drop". */
  cusumThreshold: number;
  /** CUSUM slack as a FRACTION of the target reply rate (noise tolerance). */
  cusumSlack: number;
}

export const DEFAULT_CONTACT_POLICY: ContactPolicyConfig = {
  followUpMinDays: 3,
  channelCooldownDays: 7,
  quietHourStart: 22,
  quietHourEnd: 8,
  fridayBlackoutStartMinutes: 11 * 60 + 30,
  fridayBlackoutEndMinutes: 14 * 60 + 30,
  minSpacingMinutes: 4,
  warmupDays: 14,
  warmupStartCap: 10,
  blockedThrottleDays: 7,
  blockedThrottleFactor: 0.5,
  cusumThreshold: 2.0,
  cusumSlack: 0.25,
};

export type PolicyCode =
  | 'ok'
  | 'suppressed'
  | 'terminal_state'
  | 'ordely_customer'
  | 'first_contact_limit'
  | 'followup_cooldown'
  | 'channel_cooldown'
  | 'daily_cap'
  | 'hourly_cap'
  | 'spacing'
  | 'quiet_hours'
  | 'friday_blackout'
  | 'warmup';

export interface PolicyDecision {
  allowed: boolean;
  code: PolicyCode;
  reason: string;
  /** False = hard stop (never ask again), true = retry later. */
  retryable: boolean;
  nextAllowedAt: Date | null;
}

/** Daily cap after warm-up ramp and blocked/reported throttling. */
export function dailyCapFor(state: SenderState, now: Date, config = DEFAULT_CONTACT_POLICY): number {
  const daysSinceStart = Math.max(0, (now.getTime() - state.startedAt.getTime()) / 86_400_000);
  const progress = clamp(daysSinceStart / config.warmupDays, 0, 1);
  // Logistic ramp: at t=0 → warmupStartCap, at t=warmupDays → configured cap.
  const ramp = 1 / (1 + Math.exp(-10 * (progress - 0.5)));
  const rampAtStart = 1 / (1 + Math.exp(-10 * (0 - 0.5)));
  const normalized = (ramp - rampAtStart) / (1 - rampAtStart || 1);
  const ramped = config.warmupStartCap + (state.dailyCap - config.warmupStartCap) * clamp(normalized, 0, 1);
  let cap = progress >= 1 ? state.dailyCap : ramped;
  if (state.throttleUntil && state.throttleUntil.getTime() > now.getTime()) {
    cap *= config.blockedThrottleFactor;
  }
  return Math.max(1, Math.floor(cap));
}

export function isQuietHours(now: Date, config = DEFAULT_CONTACT_POLICY): boolean {
  const wall = toAlgiersWallTime(now);
  const start = config.quietHourStart;
  const end = config.quietHourEnd;
  if (start > end) return wall.hour >= start || wall.hour < end;
  return wall.hour >= start && wall.hour < end;
}

export function isFridayBlackout(now: Date, config = DEFAULT_CONTACT_POLICY): boolean {
  const wall = toAlgiersWallTime(now);
  if (wall.weekday !== 5) return false;
  const minutes = wall.hour * 60 + wall.minute;
  return minutes >= config.fridayBlackoutStartMinutes && minutes < config.fridayBlackoutEndMinutes;
}

export function nextAllowedSendTime(now: Date, config = DEFAULT_CONTACT_POLICY): Date {
  let candidate = new Date(now.getTime());
  for (let i = 0; i < 24 * 8; i += 1) {
    if (!isQuietHours(candidate, config) && !isFridayBlackout(candidate, config)) return candidate;
    candidate = new Date(candidate.getTime() + 30 * 60_000);
  }
  return candidate;
}

export function evaluateContactPolicy(
  input: ContactPolicyInput,
  config: ContactPolicyConfig = DEFAULT_CONTACT_POLICY,
): PolicyDecision {
  const { history, now, senderState } = input;

  if (input.suppressed) {
    return {
      allowed: false,
      code: 'suppressed',
      reason: 'lead is on the global suppression list (hard stop)',
      retryable: false,
      nextAllowedAt: null,
    };
  }
  if (input.state === 'do_not_contact') {
    return {
      allowed: false,
      code: 'terminal_state',
      reason: 'lead state is do_not_contact (terminal)',
      retryable: false,
      nextAllowedAt: null,
    };
  }
  if (input.onOrdelyCustomersList) {
    return {
      allowed: false,
      code: 'ordely_customer',
      reason: 'excluded: appears in the ORDELY customers exclusion list',
      retryable: false,
      nextAllowedAt: null,
    };
  }

  const firstContacts = history.filter((entry) => entry.stage === 'first_contact');
  const followUps = history.filter((entry) => entry.stage === 'followup');
  const hostile = history.some(
    (entry) => entry.stage === 'stop' || entry.stage === 'not_interested' || entry.stage === 'reported',
  );
  if (hostile) {
    return {
      allowed: false,
      code: 'suppressed',
      reason: 'lead previously asked to stop / showed hostility (auto-suppression expected)',
      retryable: false,
      nextAllowedAt: null,
    };
  }

  const isFollowUp = firstContacts.length > 0;
  // Cross-channel safety comes first: never two channels inside 7 days, even if
  // all other conditions (including the follow-up cooldown) would allow it.
  const recentChannels = new Set(
    history
      .filter((entry) => hoursBetween(entry.occurredAt, now) / 24 < config.channelCooldownDays)
      .map((entry) => entry.channel),
  );
  if (recentChannels.size > 0 && !recentChannels.has(input.channel)) {
    return {
      allowed: false,
      code: 'channel_cooldown',
      reason: `lead contacted on ${[...recentChannels].join(', ')} within ${config.channelCooldownDays} days`,
      retryable: true,
      nextAllowedAt: null,
    };
  }

  if (isFollowUp && followUps.length >= 1) {
    return {
      allowed: false,
      code: 'first_contact_limit',
      reason: 'already sent 1 first message + 1 follow-up (policy maximum)',
      retryable: false,
      nextAllowedAt: null,
    };
  }
  if (isFollowUp && firstContacts.length > 0) {
    const lastFirst = firstContacts[firstContacts.length - 1];
    if (lastFirst) {
      const days = hoursBetween(lastFirst.occurredAt, now) / 24;
      if (days < config.followUpMinDays) {
        return {
          allowed: false,
          code: 'followup_cooldown',
          reason: `follow-up allowed only after ${config.followUpMinDays} days (elapsed ${days.toFixed(2)}d)`,
          retryable: true,
          nextAllowedAt: new Date(lastFirst.occurredAt.getTime() + config.followUpMinDays * 86_400_000),
        };
      }
    }
  }

  if (isQuietHours(now, config)) {
    return {
      allowed: false,
      code: 'quiet_hours',
      reason: 'quiet hours 22:00-08:00 Africa/Algiers',
      retryable: true,
      nextAllowedAt: nextAllowedSendTime(now, config),
    };
  }
  if (isFridayBlackout(now, config)) {
    return {
      allowed: false,
      code: 'friday_blackout',
      reason: 'Friday 11:30-14:30 blackout window',
      retryable: true,
      nextAllowedAt: nextAllowedSendTime(now, config),
    };
  }

  const dayKey = algiersDayKey(now);
  const hourKey = algiersHourKey(now);
  const cap = dailyCapFor(senderState, now, config);
  const sentToday = senderState.sentByDay[dayKey] ?? 0;
  if (sentToday >= cap) {
    return {
      allowed: false,
      code: 'daily_cap',
      reason: `daily cap reached (${sentToday}/${cap}${cap < senderState.dailyCap ? ', warm-up/throttle reduced' : ''})`,
      retryable: true,
      nextAllowedAt: nextAllowedSendTime(new Date(now.getTime() + 6 * 3_600_000), config),
    };
  }
  const sentThisHour = senderState.sentByHour[hourKey] ?? 0;
  if (sentThisHour >= senderState.platformCap) {
    return {
      allowed: false,
      code: 'hourly_cap',
      reason: `hourly cap reached (${sentThisHour}/${senderState.platformCap})`,
      retryable: true,
      nextAllowedAt: new Date(now.getTime() + 45 * 60_000),
    };
  }
  if (senderState.lastSentAt) {
    const spacing = minutesBetween(senderState.lastSentAt, now);
    if (spacing < config.minSpacingMinutes) {
      return {
        allowed: false,
        code: 'spacing',
        reason: `minimum spacing ${config.minSpacingMinutes} min between sends (elapsed ${spacing.toFixed(1)} min)`,
        retryable: true,
        nextAllowedAt: new Date(senderState.lastSentAt.getTime() + config.minSpacingMinutes * 60_000),
      };
    }
  }

  const daysSinceStart = Math.max(0, (now.getTime() - senderState.startedAt.getTime()) / 86_400_000);
  if (daysSinceStart < config.warmupDays && sentToday >= cap) {
    return {
      allowed: false,
      code: 'warmup',
      reason: `warm-up ramp in progress (day ${daysSinceStart.toFixed(1)}, cap ${cap})`,
      retryable: true,
      nextAllowedAt: null,
    };
  }

  return {
    allowed: true,
    code: 'ok',
    reason: isFollowUp ? 'follow-up allowed (>= 3 days since first contact)' : 'first contact allowed',
    retryable: false,
    nextAllowedAt: null,
  };
}

/**
 * CUSUM change detection on daily reply rates. `target` is the expected reply
 * rate; a sustained drop raises a "possible throttling" alarm.
 */
export function cusumReplyRate(
  slices: readonly { day: string; sends: number; replies: number }[],
  target: number,
  config = DEFAULT_CONTACT_POLICY,
): { statistic: number; alarm: boolean; series: { day: string; value: number; cusum: number }[] } {
  const series: { day: string; value: number; cusum: number }[] = [];
  // Scale-free one-sided downward CUSUM on the *relative* shortfall:
  //   S_i = max(0, S_{i-1} + (target - observed)/target - slack)
  // S grows while the reply rate sits below target − slack·target and resets on
  // recovery. Crossing `cusumThreshold` raises "possible throttling".
  const reference = target <= 0 ? 0.05 : target;
  let statistic = 0;
  let alarm = false;
  for (const slice of slices) {
    if (slice.sends <= 0) continue;
    const observed = slice.replies / slice.sends;
    statistic = Math.max(0, statistic + (reference - observed) / reference - config.cusumSlack);
    if (statistic > config.cusumThreshold) alarm = true;
    series.push({ day: slice.day, value: observed, cusum: statistic });
  }
  return { statistic, alarm, series };
}

export function markThrottleAfterBlocked(
  state: SenderState,
  now: Date,
  config = DEFAULT_CONTACT_POLICY,
): SenderState {
  return {
    ...state,
    throttleUntil: new Date(now.getTime() + config.blockedThrottleDays * 86_400_000),
  };
}

export function recordSend(
  state: SenderState,
  now: Date,
  channel: ChannelId,
): SenderState {
  const dayKey = algiersDayKey(now);
  const hourKey = algiersHourKey(now);
  return {
    ...state,
    lastSentAt: now,
    sentByDay: { ...state.sentByDay, [dayKey]: (state.sentByDay[dayKey] ?? 0) + 1 },
    sentByHour: { ...state.sentByHour, [hourKey]: (state.sentByHour[hourKey] ?? 0) + 1 },
    lastChannel: channel,
  } as SenderState;
}

/** Used by tests/sim: warm-up curve values. */
export function warmupCurve(cap: number, config = DEFAULT_CONTACT_POLICY): number[] {
  const out: number[] = [];
  const anchor = new Date('2026-01-01T09:00:00.000Z');
  for (let day = 0; day <= config.warmupDays; day += 1) {
    const now = new Date(anchor.getTime() + day * 86_400_000);
    out.push(
      dailyCapFor(
        {
          startedAt: anchor,
          dailyCap: cap,
          platformCap: 5,
          sentByDay: {},
          sentByHour: {},
          lastSentAt: null,
          dailyReplyRates: [],
        },
        now,
        config,
      ),
    );
  }
  return out;
}

/** Probability that a queue of leads stays under the cap given a growth curve. */
export function capUtilisation(sentToday: number, state: SenderState, now: Date): number {
  const cap = dailyCapFor(state, now);
  return clamp(sentToday / cap, 0, 1);
}

export function rampProgress(state: SenderState, now: Date, config = DEFAULT_CONTACT_POLICY): number {
  return sigmoid(
    ((now.getTime() - state.startedAt.getTime()) / 86_400_000 / config.warmupDays - 0.5) * 10,
  );
}
