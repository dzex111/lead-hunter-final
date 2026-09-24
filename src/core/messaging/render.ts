import { SPAM_BLOCKLIST, SPAM_WARNLIST } from '@/core/data/lexicons';
import { selectVariantThompson, type FunnelStagePosterior } from '@/core/math/beta';
import { normalizeAlgerianPhone } from '@/core/normalize/phone';
import { matchKey } from '@/core/normalize/text';
import type { Rng } from '@/core/random';
import {
  URL_SLOT,
  variantsForLanguage,
  type MessageTemplate,
  type TemplateVariant,
} from '@/core/messaging/templates';
import type { ChannelId, LanguageId } from '@/core/types';
import { clamp } from '@/core/util';

export const MAX_MESSAGE_CHARS = 450;
export const MAX_WA_URL_CHARS = 1900;

export interface RenderInput {
  template: MessageTemplate;
  slots: Record<string, string>;
  language: LanguageId;
  channel: ChannelId;
  rng: Rng;
  /** Optional forced variant (used by tests and by `next --variant`). */
  variantId?: string;
  /** Variant performance for Thompson sampling; falls back to prior pseudo-counts. */
  variantStats?: Record<string, { successes: number; failures: number }>;
  isFirstContact: boolean;
}

export interface RenderResult {
  variantId: string;
  language: LanguageId | 'fr' | 'ar_msa' | 'ar_dz';
  body: string;
  channel: ChannelId;
  charCount: number;
  questions: number;
  warnings: string[];
  blocked: boolean;
  validationErrors: string[];
}

export function slotNamesOf(body: string): string[] {
  const matches = body.match(/\{([a-z_]+)\}/gi) ?? [];
  return Array.from(new Set(matches.map((match) => match.replace(/[{}]/g, '').toLowerCase())));
}

export function renderTemplateBody(body: string, slots: Record<string, string>): string {
  return body.replace(/\{([a-z_]+)\}/gi, (whole, name: string) => {
    const value = slots[name.toLowerCase()];
    return value === undefined ? whole : value;
  });
}

export function countQuestions(body: string): number {
  return (body.match(/[?？؟]/g) ?? []).length;
}

export function lintMessage(
  body: string,
  options: { isFirstContact: boolean },
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const unresolved = slotNamesOf(body);
  if (unresolved.length > 0) {
    errors.push(`unresolved slots: ${unresolved.join(', ')}`);
  }
  if (body.length > MAX_MESSAGE_CHARS) {
    errors.push(`message too long (${body.length} > ${MAX_MESSAGE_CHARS} chars)`);
  }
  const urlPattern = /https?:\/\/|www\.|wa\.me|bit\.ly|\.dz\b/i;
  if (options.isFirstContact && urlPattern.test(body)) {
    errors.push('first-contact messages must not contain any URL');
  }
  const questions = countQuestions(body);
  if (questions > 1) {
    errors.push(`at most one question mark allowed (found ${questions})`);
  }
  const key = matchKey(body);
  for (const term of SPAM_BLOCKLIST) {
    if (key.includes(matchKey(term))) errors.push(`spam term blocked: "${term}"`);
  }
  for (const term of SPAM_WARNLIST) {
    if (key.includes(matchKey(term))) warnings.push(`review wording: "${term}" may look promotional`);
  }
  if (/\b(?:free money|100%|garantie totale)\b/i.test(body)) warnings.push('absolute claims detected');
  return { errors: Array.from(new Set(errors)), warnings: Array.from(new Set(warnings)) };
}

function pickVariant(input: RenderInput): TemplateVariant {
  const candidates = variantsForLanguage(input.template, input.language);
  if (input.variantId) {
    const forced = candidates.find((variant) => variant.id === input.variantId);
    if (forced) return forced;
  }
  const stats = input.variantStats;
  const withStats = (candidates.length > 0 ? candidates : input.template.variants).map((variant) => ({
    id: variant.id,
    successes: stats?.[variant.id]?.successes ?? variant.priorSuccesses,
    failures: stats?.[variant.id]?.failures ?? variant.priorFailures,
  }));
  const selected = selectVariantThompson(withStats, input.rng, { explorationRate: 0.1 });
  const chosen =
    (candidates.length > 0 ? candidates : input.template.variants).find(
      (variant) => variant.id === selected.id,
    );
  return chosen ?? (input.template.variants[0] as TemplateVariant);
}

export function renderMessage(input: RenderInput): RenderResult {
  const variant = pickVariant(input);
  const body = renderTemplateBody(variant.body, {
    ...input.slots,
    product: input.slots['product'] ?? 'منتجك',
    platform: input.slots['platform'] ?? 'متجرك',
  }).trim();
  const lint = lintMessage(body, { isFirstContact: input.isFirstContact });
  return {
    variantId: variant.id,
    language: variant.language,
    body,
    channel: input.channel,
    charCount: body.length,
    questions: countQuestions(body),
    warnings: lint.warnings,
    blocked: lint.errors.length > 0,
    validationErrors: lint.errors,
  };
}

export interface WaLinkInput {
  phone: string;
  text: string;
}

/** wa.me builder: E.164 without '+', percent-encoded text, URL length guard. */
export function buildWaLink(input: WaLinkInput): { url: string; ok: boolean; reason?: string } {
  const phone = normalizeAlgerianPhone(input.phone, { requireMobile: true });
  if (!phone) {
    return { url: '', ok: false, reason: `not a valid Algerian mobile number: ${input.phone}` };
  }
  const encoded = encodeURIComponent(input.text);
  const url = `https://wa.me/${phone.waDigits}?text=${encoded}`;
  if (url.length > MAX_WA_URL_CHARS) {
    return { url, ok: false, reason: `wa.me URL too long (${url.length} > ${MAX_WA_URL_CHARS})` };
  }
  return { url, ok: true };
}

/**
 * Messenger/Instagram have no prefilled-text URL: the engine emits copy-text +
 * profile link so the operator pastes and sends manually.
 */
export function buildSocialHandoff(input: {
  channel: ChannelId;
  handleOrUrl: string;
  text: string;
}): { copyText: string; profileUrl: string; instructions: string } {
  const profileUrl = /^https?:/.test(input.handleOrUrl)
    ? input.handleOrUrl
    : input.channel === 'instagram'
      ? `https://www.instagram.com/${input.handleOrUrl}`
      : input.channel === 'messenger'
        ? `https://m.me/${input.handleOrUrl}`
        : input.channel === 'tiktok'
          ? `https://www.tiktok.com/@${input.handleOrUrl}`
          : `https://www.facebook.com/${input.handleOrUrl}`;
  return {
    copyText: input.text,
    profileUrl,
    instructions:
      'Ouvrir le profil, coller le texte, envoyer manuellement. Aucun envoi automatique — jamais.',
  };
}

export interface PriorityLink {
  channel: ChannelId;
  target: string;
  waLink?: string;
  copyText: string;
  instructions: string;
}

export function buildOutreachLink(
  channel: ChannelId,
  target: string,
  text: string,
): { ok: boolean; reason?: string; link?: PriorityLink } {
  if (channel === 'whatsapp') {
    const wa = buildWaLink({ phone: target, text });
    if (!wa.ok) return { ok: false, reason: wa.reason };
    return {
      ok: true,
      link: {
        channel,
        target,
        waLink: wa.url,
        copyText: text,
        instructions: 'Cliquer le lien wa.me puis envoyer (l\'humain envoie, jamais le moteur).',
      },
    };
  }
  if (channel === 'email') {
    const url = `mailto:${target}?body=${encodeURIComponent(text)}`;
    return {
      ok: true,
      link: { channel, target, copyText: text, instructions: `mailto pré-rempli: ${url}` },
    };
  }
  if (channel === 'phone') {
    return {
      ok: true,
      link: {
        channel,
        target: `tel:${target}`,
        copyText: text,
        instructions: 'Appeler manuellement — script affiché à l\'écran. Aucun appel automatique.',
      },
    };
  }
  const handoff = buildSocialHandoff({ channel, handleOrUrl: target, text });
  return {
    ok: true,
    link: {
      channel,
      target: handoff.profileUrl,
      copyText: handoff.copyText,
      instructions: handoff.instructions,
    },
  };
}

export function variantPosteriors(
  template: MessageTemplate,
  outcomes: readonly { variantId: string; sent: number; replied: number }[],
  global: FunnelStagePosterior,
): { id: string; successes: number; failures: number; mean: number }[] {
  return template.variants.map((variant) => {
    const own = outcomes.find((entry) => entry.variantId === variant.id);
    const successes = variant.priorSuccesses + (own?.replied ?? 0);
    const failures = variant.priorFailures + Math.max(0, (own?.sent ?? 0) - (own?.replied ?? 0));
    // Shrink toward the global reply rate with a small strength so a variant with
    // 3 sends cannot dominate a variant with 30 sends.
    const strength = 2;
    const mean =
      (successes + strength * global.mean) / (successes + failures + strength);
    return { id: variant.id, successes, failures, mean: clamp(mean, 0, 1) };
  });
}
