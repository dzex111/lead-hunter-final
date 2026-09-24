import { LEAD_STATES, type LeadState } from '@/core/types';

/**
 * Explicit lead lifecycle state machine. Transitions outside this table are
 * rejected, and every transition can carry a guard (returned as a reason string
 * for the audit log).
 */
export const ALLOWED_TRANSITIONS: Record<LeadState, readonly LeadState[]> = {
  new: ['enriched', 'disqualified', 'do_not_contact'],
  enriched: ['qualified', 'disqualified', 'do_not_contact'],
  qualified: ['queued', 'disqualified', 'do_not_contact', 'lost'],
  disqualified: ['enriched', 'do_not_contact'],
  queued: ['drafted', 'qualified', 'do_not_contact', 'lost'],
  drafted: ['sent', 'queued', 'do_not_contact', 'lost'],
  sent: ['replied', 'lost', 'do_not_contact'],
  replied: ['interested', 'lost', 'do_not_contact'],
  interested: ['signed_up', 'lost', 'do_not_contact'],
  signed_up: ['activated', 'lost', 'do_not_contact'],
  activated: ['paid', 'lost', 'do_not_contact'],
  paid: ['lost', 'do_not_contact'],
  lost: ['replied', 'queued', 'do_not_contact'],
  do_not_contact: [],
};

export const STAGE_RANK: Record<LeadState, number> = {
  new: 0,
  enriched: 1,
  qualified: 2,
  disqualified: 2,
  queued: 3,
  drafted: 4,
  sent: 5,
  replied: 6,
  interested: 7,
  signed_up: 8,
  activated: 9,
  paid: 10,
  lost: 3,
  do_not_contact: 99,
};

export interface TransitionContext {
  hasObservations: boolean;
  hasContactableChannel: boolean;
  qualified: boolean;
  suppressed: boolean;
  hasDraft: boolean;
  policyAllowed: boolean;
  outcomeNote?: string;
}

export type GuardResult = { allowed: true } | { allowed: false; reason: string };

export type TransitionGuard = (from: LeadState, to: LeadState, ctx: TransitionContext) => GuardResult;

export const TRANSITION_GUARDS: Record<string, TransitionGuard> = {
  toEnriched: (_from, to, ctx) => {
    if (to !== 'enriched') return { allowed: true };
    return ctx.hasObservations
      ? { allowed: true }
      : { allowed: false, reason: 'cannot enrich without at least one observation' };
  },
  toQualified: (_from, to, ctx) => {
    if (to !== 'qualified' && to !== 'queued') return { allowed: true };
    if (!ctx.qualified) return { allowed: false, reason: 'hard qualification gates not satisfied' };
    if (ctx.suppressed) return { allowed: false, reason: 'lead is globally suppressed' };
    if (!ctx.hasContactableChannel) return { allowed: false, reason: 'no contactable channel' };
    return { allowed: true };
  },
  toDrafted: (_from, to, ctx) => {
    if (to !== 'drafted') return { allowed: true };
    return ctx.hasDraft ? { allowed: true } : { allowed: false, reason: 'no rendered draft attached' };
  },
  toSent: (_from, to, ctx) => {
    if (to !== 'sent') return { allowed: true };
    if (!ctx.policyAllowed) return { allowed: false, reason: 'contact policy blocked this send' };
    if (ctx.suppressed) return { allowed: false, reason: 'lead is globally suppressed' };
    return { allowed: true };
  },
  fromDoNotContact: (from, to) => {
    if (from !== 'do_not_contact') return { allowed: true };
    return to === 'do_not_contact'
      ? { allowed: true }
      : { allowed: false, reason: 'do_not_contact is terminal (suppression is a hard stop)' };
  },
};

export interface TransitionCheck {
  allowed: boolean;
  reasons: string[];
}

export function canTransition(
  from: LeadState,
  to: LeadState,
  ctx: TransitionContext,
): TransitionCheck {
  if (from === to) return { allowed: true, reasons: ['no-op transition'] };
  const allowedTargets = ALLOWED_TRANSITIONS[from];
  if (!allowedTargets.includes(to)) {
    return { allowed: false, reasons: [`${from} → ${to} is not in the allowed transition table`] };
  }
  const reasons: string[] = [];
  for (const guard of Object.values(TRANSITION_GUARDS)) {
    const result = guard(from, to, ctx);
    if (!result.allowed) reasons.push(result.reason);
  }
  return { allowed: reasons.length === 0, reasons };
}

export function assertTransition(from: LeadState, to: LeadState, ctx: TransitionContext): void {
  const check = canTransition(from, to, ctx);
  if (!check.allowed) {
    throw new Error(`illegal lead transition ${from} → ${to}: ${check.reasons.join('; ')}`);
  }
}

export function isTerminal(state: LeadState): boolean {
  return state === 'do_not_contact';
}

export function nextStageFromOutcome(stage: string): LeadState | null {
  const map: Record<string, LeadState> = {
    contacted: 'sent',
    replied: 'replied',
    interested: 'interested',
    signed_up: 'signed_up',
    activated: 'activated',
    paid: 'paid',
    lost: 'lost',
    blocked: 'lost',
    reported: 'lost',
    stop: 'do_not_contact',
    not_interested: 'lost',
    do_not_contact: 'do_not_contact',
  };
  return map[stage] ?? null;
}

export const ALL_STATES: readonly LeadState[] = LEAD_STATES;
