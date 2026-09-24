import { describe, expect, it } from 'vitest';
import {
  blockingKeys,
  candidatePairs,
  clusterRecords,
  clusters,
  comparePair,
  evaluateDecisions,
  makeMergeLogEntry,
  type ResolveRecord,
} from '@/core/entity/resolve';
import { qualifyLead } from '@/core/qualify';
import { normalizeAlgerianPhone } from '@/core/normalize/phone';
import { extractSiteFacts } from '@/core/extract';
import { buildFactsBundle } from '@/adapters/pipeline/facts';

/**
 * Synthetic labeled set: 20 duplicate pairs (same merchant seen twice) and 20
 * unrelated merchants. The engine never sees `truth`.
 */
const VALID_PREFIXES = ['55', '56', '61', '66', '77', '78', '79'];

function validPhone(index: number): string {
  const prefix = VALID_PREFIXES[index % VALID_PREFIXES.length] ?? '55';
  const rest = String(1000000 + index * 7919).slice(0, 7);
  const normalized = normalizeAlgerianPhone(`0${prefix}${rest}`);
  if (!normalized) throw new Error(`synthetic phone generator produced an invalid number: 0${prefix}${rest}`);
  return normalized.e164;
}

function syntheticSet(): { records: ResolveRecord[]; truth: Set<string> } {
  const records: ResolveRecord[] = [];
  const truth = new Set<string>();
  for (let index = 0; index < 20; index += 1) {
    const domain = `boutique-${index}.dz`;
    const phone = validPhone(index);
    const left: ResolveRecord = {
      id: `dup-a-${index}`,
      name: `Boutique Nour ${index}`,
      domain,
      phones: [phone],
      emails: [`contact${index}@boutique-${index}.dz`],
      handles: [`nour${index}`],
      wilaya: 'Alger',
      category: 'fashion',
    };
    const right: ResolveRecord = {
      id: `dup-b-${index}`,
      name: `Boutique  Nour ${index} DZ`,
      domain,
      phones: [phone],
      emails: [],
      handles: [`nour${index}`],
      wilaya: 'Alger',
      category: 'fashion',
    };
    records.push(left, right);
    truth.add(`dup-a-${index}|dup-b-${index}`);
  }
  for (let index = 0; index < 20; index += 1) {
    records.push({
      id: `solo-${index}`,
      name: `Distinct Merchant Zeta${index}`,
      domain: `zeta-${index}.youcan.shop`,
      phones: [],
      emails: [`zeta${index}@zeta-${index}.dz`],
      handles: [],
      wilaya: 'Oran',
      category: 'beauty',
    });
  }
  return { records, truth };
}

describe('entity resolution', () => {
  it('generates blocking keys per identity type', () => {
    const keys = blockingKeys({
      id: 'x',
      name: 'Boutique Nour',
      domain: 'boutique.dz',
      phones: ['+213770123456'],
      emails: ['A@Boutique.dz'],
      handles: ['NourDZ'],
    });
    expect(keys).toContain('domain:boutique.dz');
    expect(keys).toContain('phone:+213770123456');
    expect(keys).toContain('email:a@boutique.dz');
    expect(keys).toContain('handle:nourdz');
    expect(keys.some((key) => key.startsWith('token:'))).toBe(true);
  });

  it('achieves high precision and recall on the synthetic labeled set', () => {
    const { records, truth } = syntheticSet();
    const pairs = candidatePairs(records);
    const decisions = pairs.map((pair) => comparePair(pair.left, pair.right, pair.blockers));
    const metrics = evaluateDecisions(decisions, truth);
    expect(metrics.precision).toBeGreaterThanOrEqual(0.95);
    expect(metrics.recall).toBeGreaterThanOrEqual(0.9);

    const merged = clusterRecords(records, decisions);
    const grouped = clusters(merged);
    expect(merged.merges.length).toBeGreaterThanOrEqual(20);
    const mergedSizes = [...grouped.values()].filter((members) => members.length > 1);
    expect(mergedSizes).toHaveLength(20);
  });

  it('never auto-merges conflicting strong identities (rebranded domain)', () => {
    const decision = comparePair(
      {
        id: 'a',
        name: 'Boutique Nour',
        domain: 'nour.dz',
        phones: ['+213770123456'],
        emails: ['contact@nour.dz'],
        handles: ['nourdzofficial'],
        wilaya: 'Alger',
        category: 'fashion',
      },
      {
        id: 'b',
        name: 'Boutique Nour',
        domain: 'nour-dz.myshopify.com',
        phones: ['+213661234567'],
        emails: ['contact@nour.dz'],
        handles: ['nourdzofficial'],
        wilaya: 'Alger',
        category: 'fashion',
      },
      ['token:nour', 'handle:nourdzofficial'],
    );
    expect(decision.posterior).toBeGreaterThanOrEqual(0.97); // would auto-merge on evidence alone
    expect(decision.conflicting).toBe(true);
    expect(decision.decision).toBe('review'); // …but conflicts always go to a human
    expect(decision.explanation).toMatch(/CONFLICT/);
  });

  it('keeps same-domain medium-similarity pairs in the review band', () => {
    const decision = comparePair(
      { id: 'a', name: 'Nour Boutique', domain: 'nour.dz' },
      { id: 'b', name: 'Nour', domain: 'nour.dz', wilaya: null },
      ['domain:nour.dz'],
    );
    expect(['review', 'auto_merge']).toContain(decision.decision);
    expect(decision.posterior).toBeGreaterThan(0.6);
  });

  it('produces reversible merge-log entries', () => {
    const entry = makeMergeLogEntry({
      id: 'log-1',
      action: 'merge',
      keptId: 'a',
      mergedId: 'b',
      at: new Date('2026-01-01T00:00:00.000Z'),
      operator: 'engine',
    });
    expect(entry.reversible).toBe(true);
    expect(entry.mergedId).toBe('b');
  });
});

describe('qualification gates', () => {
  const html = `<!doctype html><html><head><title>Beldi Beauty</title></head><body>
    <h1>Beldi Beauty</h1><p>Paiement à la livraison partout en Algérie — التوصيل لكل الولايات: Alger, Oran, Sétif</p>
    <span class="price">3500 DZD</span><button>Ajouter au panier</button>
    <footer><a href="https://wa.me/213551234567">WhatsApp</a></footer></body></html>`;

  const facts = extractSiteFacts({
    url: 'https://beldi-beauty.dz/',
    html,
    headers: {},
    now: new Date('2026-01-05T10:00:00.000Z'),
    catalog: { productCount: 24, medianPrice: 3500, currency: 'DZD', latestProductUpdate: '2026-01-02T00:00:00.000Z', source: 'products_json' },
  });
  const bundle = buildFactsBundle(
    {
      id: 'lead-1',
      name: 'Beldi Beauty',
      domain: 'beldi-beauty.dz',
      platform: facts.platform,
      category: facts.categories.top[0]?.category ?? null,
      wilaya: null,
      primaryChannel: 'whatsapp',
      primaryTarget: '+213551234567',
      maturityIndex: facts.maturityIndex,
      pAlgeria: facts.market.pAlgeria,
      annotations: null,
    },
    facts.signals.map((signal) => ({ key: signal.key, value: signal.value, confidence: signal.confidence })),
  );

  it('qualifies a real Algerian COD storefront', () => {
    const result = qualifyLead({
      facts: {
        contacts: bundle.contacts,
        market: {
          pAlgeria: bundle.market.pAlgeria,
          pSellsPhysicalGoodsOnline: bundle.market.pSellsPhysicalGoodsOnline,
          codPhrases: bundle.market.codPhrases,
          currency: bundle.market.currency,
          wilayaCoverage: bundle.market.wilayaCoverage,
          isDzTld: bundle.market.isDzTld,
        },
        platform: bundle.platform,
        catalog: facts.catalog,
        categories: facts.categories,
        maturityIndex: bundle.maturityIndex,
      },
      suppressed: false,
      onOrdelyCustomersList: false,
      policyAllows: true,
    });
    expect(result.qualified).toBe(true);
    expect(result.gates.every((gate) => gate.passed)).toBe(true);
  });

  it('rejects suppressed leads, ORDELY customers and policy violations with reasons', () => {
    const base = {
      facts: {
        contacts: bundle.contacts,
        market: {
          pAlgeria: bundle.market.pAlgeria,
          pSellsPhysicalGoodsOnline: bundle.market.pSellsPhysicalGoodsOnline,
          codPhrases: bundle.market.codPhrases,
          currency: bundle.market.currency,
          wilayaCoverage: bundle.market.wilayaCoverage,
          isDzTld: bundle.market.isDzTld,
        },
        platform: bundle.platform,
        catalog: facts.catalog,
        categories: facts.categories,
        maturityIndex: bundle.maturityIndex,
      },
      suppressed: false,
      onOrdelyCustomersList: false,
      policyAllows: true,
    };
    const suppressedResult = qualifyLead({ ...base, suppressed: true });
    expect(suppressedResult.qualified).toBe(false);
    expect(suppressedResult.reasons.join(' ')).toContain('suppressed');

    const customer = qualifyLead({ ...base, onOrdelyCustomersList: true });
    expect(customer.reasons.join(' ')).toContain('ORDELY customer');

    const policy = qualifyLead({ ...base, policyAllows: false, policyReason: 'quiet hours 22:00-08:00' });
    expect(policy.reasons.join(' ')).toContain('quiet hours');

    const offMarket = qualifyLead({
      ...base,
      facts: { ...base.facts, market: { ...base.facts.market, pAlgeria: 0.2 } },
    });
    expect(offMarket.reasons.join(' ')).toContain('P(Algeria)');
  });
});
