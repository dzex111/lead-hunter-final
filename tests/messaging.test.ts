import { describe, expect, it } from 'vitest';
import { TEMPLATES, templateById, variantsForLanguage } from '@/core/messaging/templates';
import {
  MAX_MESSAGE_CHARS,
  buildOutreachLink,
  buildSocialHandoff,
  buildWaLink,
  countQuestions,
  lintMessage,
  renderMessage,
  renderTemplateBody,
  slotNamesOf,
} from '@/core/messaging/render';
import { classifyCategories, categoryTokenHits } from '@/core/classify/categories';
import { maturityIndex } from '@/core/classify/maturity';
import { createRng } from '@/core/random';
import { CATEGORY_IDS } from '@/core/types';

describe('template catalogue', () => {
  it('ships every required template with at least two language variants', () => {
    const required = [
      'first_contact.advertiser',
      'first_contact.messaging_only',
      'first_contact.other_platform',
      'first_contact.new_small',
      'followup.once',
      'reply.interested_link',
      'post_signup.pro_gift',
    ];
    for (const id of required) {
      const template = templateById(id);
      expect(template, id).not.toBeNull();
      expect(template?.variants.length ?? 0).toBeGreaterThanOrEqual(2);
      const languages = new Set((template?.variants ?? []).map((variant) => variant.language));
      expect(languages.size).toBeGreaterThanOrEqual(2);
    }
  });

  it('keeps the required seed wording (light Algerian Darija)', () => {
    const template = templateById('first_contact.advertiser');
    const arabic = template?.variants.find((variant) => variant.language === 'ar_dz');
    expect(arabic?.body).toContain('شفت الإعلان تاع {product}');
    expect(arabic?.body).toContain('باش تنقص الـ retour');
    const followup = templateById('followup.once')?.variants[0];
    expect(followup?.body).toContain('ما كاين حتى مشكل');
    const gift = templateById('post_signup.pro_gift')?.variants[0];
    expect(gift?.body).toContain('خطة PRO');
  });

  it('declares the slots each body actually uses', () => {
    for (const template of TEMPLATES) {
      const declared = new Set(template.slots);
      for (const variant of template.variants) {
        for (const slot of slotNamesOf(variant.body)) {
          expect(declared.has(slot), `${variant.id} uses undeclared slot {${slot}}`).toBe(true);
        }
      }
    }
  });

  it('selects variants by detected language with a mixed fallback', () => {
    const template = templateById('first_contact.advertiser');
    expect(variantsForLanguage(template!, 'fr').every((variant) => variant.language === 'fr')).toBe(true);
    expect(variantsForLanguage(template!, 'ar_dz').length).toBeGreaterThanOrEqual(1);
    expect(variantsForLanguage(template!, 'mixed').length).toBeGreaterThanOrEqual(1);
  });
});

describe('rendering + validators', () => {
  const render = (id: string, language: 'ar_dz' | 'ar_msa' | 'fr' | 'mixed', channel: 'whatsapp' | 'messenger' = 'whatsapp', variantId?: string) => {
    const template = templateById(id)!;
    return renderMessage({
      template,
      slots: { name: 'نور', product: 'العطور', platform: 'YouCan', link: 'https://app.ordely.example/signup' },
      language,
      channel,
      rng: createRng(42),
      isFirstContact: template.stage === 'first_contact',
      ...(variantId ? { variantId } : {}),
    });
  };

  it('renders every first-contact variant without unresolved slots or URLs', () => {
    for (const template of TEMPLATES.filter((entry) => entry.stage === 'first_contact')) {
      for (const variant of template.variants) {
        const rendered = render(template.id, variant.language as 'ar_dz', 'whatsapp', variant.id);
        expect(rendered.validationErrors, `${variant.id}: ${rendered.validationErrors.join(',')}`).toHaveLength(0);
        expect(rendered.body).not.toMatch(/\{[a-z_]+\}/i);
        expect(rendered.body).not.toMatch(/https?:\/\//);
        expect(rendered.charCount).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
        expect(rendered.questions).toBeLessThanOrEqual(1);
      }
    }
  });

  it('rejects first-contact messages containing a URL and duplicate questions', () => {
    const withUrl = lintMessage('السلام عليكم، شوف https://ordely.example', { isFirstContact: true });
    expect(withUrl.errors.join(' ')).toMatch(/must not contain any URL/);
    const twoQuestions = lintMessage('تحب تجرب؟ ولا نخليها؟', { isFirstContact: true });
    expect(twoQuestions.errors.join(' ')).toMatch(/at most one question mark/);
    const spam = lintMessage('Offre limitée cliquez ici', { isFirstContact: false });
    expect(spam.errors.join(' ')).toMatch(/spam term/);
  });

  it('is deterministic for a fixed seed and varies across seeds', () => {
    const a = render('first_contact.advertiser', 'ar_dz');
    const b = render('first_contact.advertiser', 'ar_dz');
    expect(a.body).toBe(b.body);
    expect(countQuestions(a.body)).toBeLessThanOrEqual(1);
    const variants = new Set(
      Array.from({ length: 30 }, (_value, index) => {
        const template = templateById('first_contact.other_platform')!;
        return renderMessage({
          template,
          slots: { name: 'Nour', product: 'الملابس', platform: 'Shopify', link: 'https://x' },
          language: 'mixed',
          channel: 'whatsapp',
          rng: createRng(index),
          isFirstContact: true,
        }).variantId;
      }),
    );
    expect(variants.size).toBeGreaterThan(1); // Thompson sampling explores
  });

  it('fills slots and leaves unknown slots untouched', () => {
    expect(renderTemplateBody('مرحبا {name}', { name: 'نور' })).toBe('مرحبا نور');
    expect(renderTemplateBody('مرحبا {unknown}', {})).toBe('مرحبا {unknown}');
  });

  it('builds wa.me links with encoded text and guards length/validity', () => {
    const link = buildWaLink({ phone: '0555123456', text: 'السلام عليكم {name}' });
    expect(link.ok).toBe(true);
    expect(link.url.startsWith('https://wa.me/213555123456?text=')).toBe(true);
    expect(link.url).toContain(encodeURIComponent('السلام عليكم'));
    const invalid = buildWaLink({ phone: '021234567', text: 'hi' });
    expect(invalid.ok).toBe(false);
    expect(invalid.reason).toMatch(/not a valid Algerian mobile/);
    const long = buildWaLink({ phone: '0555123456', text: 'ا'.repeat(4000) });
    expect(long.ok).toBe(false);
    expect(long.reason).toMatch(/too long/);
  });

  it('produces copy-text + profile link handoffs for social channels (no auto-send)', () => {
    const handoff = buildSocialHandoff({ channel: 'instagram', handleOrUrl: 'beldi.beauty', text: 'سلام' });
    expect(handoff.profileUrl).toBe('https://www.instagram.com/beldi.beauty');
    expect(handoff.instructions).toMatch(/Aucun envoi automatique/);
    const whatsapp = buildOutreachLink('whatsapp', '+213555123456', 'سلام');
    expect(whatsapp.ok).toBe(true);
    expect(whatsapp.link?.waLink).toContain('wa.me/213555123456');
    const messenger = buildOutreachLink('messenger', 'beldi', 'سلام');
    expect(messenger.link?.target).toBe('https://m.me/beldi');
    const email = buildOutreachLink('email', 'contact@x.dz', 'سلام');
    expect(email.link?.instructions).toContain('mailto');
  });
});

describe('category classifier and maturity index', () => {
  it('classifies ar/fr/en merchant copy into the right vertical with probabilities', () => {
    const cases: [string, string][] = [
      ['فساتين و عبايات نسائية بجودة عالية', 'fashion'],
      ['Parfum et maquillage importés, crème et sérum', 'beauty'],
      ['سماعات بلوتوث و شواحن هاتف ايفون', 'phones_accessories'],
      ['مكملات غذائية و فيتامين للتنحيف', 'health_supplements'],
      ['Ustensiles de cuisine, casseroles et tapis de salon', 'home_kitchen'],
    ];
    for (const [text, expected] of cases) {
      const prediction = classifyCategories({ text });
      expect(prediction.top[0]?.category, text).toBe(expected);
      const sum = CATEGORY_IDS.reduce(
        (acc, category) => acc + (prediction.top.find((entry) => entry.category === category)?.probability ?? 0),
        0,
      );
      expect(sum).toBeLessThanOrEqual(1.000001);
      expect(prediction.top.length).toBe(3);
    }
  });

  it('abstains when there is no signal', () => {
    const prediction = classifyCategories({ text: 'zzz qqq' });
    expect(prediction.abstained).toBe(true);
    expect(categoryTokenHits('zzz').fashion).toHaveLength(0);
  });

  it('increases the maturity index with catalogue size, freshness, pixels and channels', () => {
    const base = maturityIndex({
      productCount: 5,
      freshnessDays: 60,
      pixelCount: 0,
      hasServerSidePixel: false,
      distinctChannelCount: 1,
      platform: 'shopify',
    });
    const mature = maturityIndex({
      productCount: 120,
      freshnessDays: 1,
      pixelCount: 3,
      hasServerSidePixel: true,
      distinctChannelCount: 4,
      platform: 'shopify',
    });
    expect(mature).toBeGreaterThan(base);
    expect(mature).toBeLessThanOrEqual(100);
    expect(base).toBeGreaterThanOrEqual(0);
    const differentStack = maturityIndex({
      productCount: 5,
      freshnessDays: 60,
      pixelCount: 0,
      hasServerSidePixel: false,
      distinctChannelCount: 1,
      platform: 'none',
    });
    expect(differentStack).toBeLessThan(base);
  });
});
