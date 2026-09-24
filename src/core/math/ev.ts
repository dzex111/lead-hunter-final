import type { ChannelId } from '@/core/types';
import { clamp } from '@/core/util';

/**
 * Expected-value and priority scoring.
 *   EV = p_reply · p_interested|reply · p_signup|interested · p_activate|signup
 *        · [ p_paid|activate · V_paid + (1 - p_paid|activate) · V_free ]
 *   priority = EV / E[effort_seconds(channel)]
 * Baseline economics: ORDELY PRO = 899 DZD/month (see docs/MATH.md §4).
 */
export interface EvConfig {
  valuePaid: number;
  valueFree: number;
  /** Monthly gross margin retained by the operator (default 100%). */
  marginFactor: number;
  /** Retention horizon in months used to value a paid customer. */
  horizonMonths: number;
  effortSeconds: Record<ChannelId, number>;
}

export const DEFAULT_EV_CONFIG: EvConfig = {
  valuePaid: 899,
  valueFree: 0,
  marginFactor: 1,
  horizonMonths: 3,
  effortSeconds: {
    whatsapp: 12,
    messenger: 20,
    instagram: 20,
    facebook: 20,
    tiktok: 25,
    email: 35,
    phone: 45,
  },
};

export interface FunnelProbabilities {
  pReply: number;
  pInterestedGivenReply: number;
  pSignupGivenInterested: number;
  pActivateGivenSignup: number;
  pPaidGivenActivate: number;
}

export function expectedValue(
  funnel: FunnelProbabilities,
  config: EvConfig = DEFAULT_EV_CONFIG,
): number {
  const paidValue = config.valuePaid * config.marginFactor * config.horizonMonths;
  const perActivation =
    clamp(funnel.pPaidGivenActivate, 0, 1) * paidValue +
    (1 - clamp(funnel.pPaidGivenActivate, 0, 1)) * config.valueFree;
  return (
    clamp(funnel.pReply, 0, 1) *
    clamp(funnel.pInterestedGivenReply, 0, 1) *
    clamp(funnel.pSignupGivenInterested, 0, 1) *
    clamp(funnel.pActivateGivenSignup, 0, 1) *
    perActivation
  );
}

export function priorityScore(expectedValueValue: number, effortSeconds: number): number {
  const effort = effortSeconds <= 0 ? 1 : effortSeconds;
  return expectedValueValue / effort;
}

/** Effort in seconds: observed medians when available, otherwise the prior table. */
export function effortForChannel(
  channel: ChannelId,
  observedMedians: Partial<Record<ChannelId, number>> = {},
  config: EvConfig = DEFAULT_EV_CONFIG,
): number {
  const observed = observedMedians[channel];
  if (observed !== undefined && observed > 0) {
    // Shrink the observed median toward the prior (10 pseudo-observations).
    const prior = config.effortSeconds[channel];
    return (observed * 10 + prior * 10) / 20;
  }
  return config.effortSeconds[channel];
}

export function combineUcbAndEv(ucb: number, expectedValueValue: number, exploration: boolean): number {
  const evPart = Math.log1p(Math.max(expectedValueValue, 0)) * 10;
  return evPart + (exploration ? 0.6 : 0.4) * ucb * 10;
}
