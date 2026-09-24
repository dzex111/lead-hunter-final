import type { QualifyResult, SiteFacts } from '@/core/types';
import { clamp } from '@/core/util';

/**
 * Hard qualification gates. Every gate is logged with a reason so the operator
 * (and the audit log) can see exactly why a lead entered or left the queue.
 */
export interface QualifyInput {
  facts: Pick<
    SiteFacts,
    'contacts' | 'market' | 'platform' | 'catalog' | 'categories' | 'maturityIndex'
  >;
  suppressed: boolean;
  onOrdelyCustomersList: boolean;
  policyAllows: boolean;
  policyReason?: string;
  minimumMaturity?: number;
}

export const QUALIFY_THRESHOLDS = {
  pAlgeria: 0.7,
  pSellsPhysical: 0.6,
  minimumMaturity: 0,
} as const;

export function qualifyLead(input: QualifyInput): QualifyResult {
  const gates: QualifyResult['gates'] = [];
  const reasons: string[] = [];

  const contactable = input.facts.contacts.some(
    (channel) =>
      channel.kind === 'whatsapp' ||
      channel.kind === 'messenger' ||
      channel.kind === 'instagram' ||
      channel.kind === 'facebook' ||
      channel.kind === 'email',
  );
  gates.push({
    gate: 'contactable_channel',
    passed: contactable,
    detail: contactable
      ? `channels: ${Array.from(new Set(input.facts.contacts.map((channel) => channel.kind))).join(', ')}`
      : 'no WhatsApp/Messenger/Instagram/Facebook/email channel found',
  });
  if (!contactable) reasons.push('no contactable channel');

  const algeriaOk = input.facts.market.pAlgeria >= QUALIFY_THRESHOLDS.pAlgeria;
  gates.push({
    gate: 'p_algeria',
    passed: algeriaOk,
    detail: `P(Algeria)=${input.facts.market.pAlgeria.toFixed(3)} (>= ${QUALIFY_THRESHOLDS.pAlgeria})`,
  });
  if (!algeriaOk) reasons.push('P(Algeria) below threshold');

  const storeOk = input.facts.market.pSellsPhysicalGoodsOnline >= QUALIFY_THRESHOLDS.pSellsPhysical;
  gates.push({
    gate: 'p_sells_physical_goods',
    passed: storeOk,
    detail: `P(sells physical goods online)=${input.facts.market.pSellsPhysicalGoodsOnline.toFixed(3)} (>= ${QUALIFY_THRESHOLDS.pSellsPhysical})`,
  });
  if (!storeOk) reasons.push('P(sells physical goods online) below threshold');

  gates.push({
    gate: 'not_suppressed',
    passed: !input.suppressed,
    detail: input.suppressed ? 'lead is on the global suppression list' : 'not suppressed',
  });
  if (input.suppressed) reasons.push('suppressed');

  gates.push({
    gate: 'not_ordely_customer',
    passed: !input.onOrdelyCustomersList,
    detail: input.onOrdelyCustomersList
      ? 'found in ORDELY customers exclusion CSV'
      : 'not in ORDELY customers list',
  });
  if (input.onOrdelyCustomersList) reasons.push('already an ORDELY customer');

  gates.push({
    gate: 'contact_policy',
    passed: input.policyAllows,
    detail: input.policyAllows
      ? 'contact policy allows outreach'
      : `contact policy blocked: ${input.policyReason ?? 'unknown'}`,
  });
  if (!input.policyAllows) reasons.push(`contact policy: ${input.policyReason ?? 'blocked'}`);

  const minMaturity = input.minimumMaturity ?? QUALIFY_THRESHOLDS.minimumMaturity;
  const maturityOk = input.facts.maturityIndex >= minMaturity;
  gates.push({
    gate: 'maturity_floor',
    passed: maturityOk,
    detail: `maturity=${input.facts.maturityIndex.toFixed(1)} (>= ${minMaturity})`,
  });
  if (!maturityOk) reasons.push('maturity below configured floor');

  const qualified = reasons.length === 0;
  return {
    qualified,
    reasons: qualified ? ['all hard gates passed'] : reasons,
    gates,
  };
}

export function qualificationSummary(result: QualifyResult): string {
  return result.gates
    .map((gate) => `${gate.passed ? '✓' : '✗'} ${gate.gate}: ${gate.detail}`)
    .join('\n');
}

export function pAlgeriaHint(facts: SiteFacts): number {
  return clamp(facts.market.pAlgeria, 0, 1);
}
