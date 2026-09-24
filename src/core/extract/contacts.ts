import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { extractEmails, extractHandles, normalizeHandle, type NormalizedHandle } from '@/core/normalize/handles';
import { extractAllAlgerianPhones, normalizeAlgerianPhone } from '@/core/normalize/phone';
import type { ChannelId, ContactChannel, Evidence } from '@/core/types';
import { uniqueBy } from '@/core/util';

export interface ContactExtractionInput {
  url: string;
  html: string;
  /** Limits text scanning cost; defaults to 600k chars of visible text. */
  textLimit?: number;
}

const CHANNEL_CONFIDENCE: Record<ChannelId, number> = {
  whatsapp: 0.95,
  messenger: 0.9,
  instagram: 0.85,
  facebook: 0.85,
  tiktok: 0.8,
  phone: 0.8,
  email: 0.6,
};

const FLOATING_HINTS = /whatsapp|float|fixed|sticky|fab|chat-widget|crisp|tawk|pulse/i;

function placementOf($: CheerioAPI, element: AnyNode, htmlIndex: number, htmlLength: number): string {
  let node = $(element);
  for (let depth = 0; depth < 8; depth += 1) {
    const tag = node.prop('tagName');
    const className = node.attr('class') ?? '';
    const id = node.attr('id') ?? '';
    if (tag === 'FOOTER') return 'footer';
    if (tag === 'HEADER') return 'header';
    if (FLOATING_HINTS.test(className) || FLOATING_HINTS.test(id)) return 'floating';
    const parent = node.parent();
    if (parent.length === 0) break;
    node = parent;
  }
  if (htmlLength > 0 && htmlIndex / htmlLength < 0.15) return 'header';
  return 'body';
}

export function extractContacts(input: ContactExtractionInput): ContactChannel[] {
  const html = input.html;
  const $ = cheerio.load(html);
  const found: ContactChannel[] = [];

  const push = (channel: ContactChannel): void => {
    if (found.some((existing) => existing.kind === channel.kind && existing.value === channel.value)) return;
    found.push(channel);
  };

  $('a[href]').each((_index, element) => {
    const href = $(element).attr('href');
    if (!href) return;
    const anchorIndex = html.indexOf(`href="${href}"`);
    const placement = anchorIndex >= 0 ? placementOf($, element, anchorIndex, html.length) : 'body';
    const label = ($(element).text() || $(element).attr('aria-label') || '').trim().slice(0, 60);

    if (/^(https?:)?\/\/(?:api\.)?wa\.me\//i.test(href) || /api\.whatsapp\.com\/send/i.test(href)) {
      const phoneMatch = href.match(/(?:wa\.me\/|phone=)(\+?\d{8,15})/);
      const phone = phoneMatch?.[1] ? normalizeAlgerianPhone(phoneMatch[1], { requireMobile: true }) : null;
      if (!phone) return;
      push({
        kind: 'whatsapp',
        value: phone.e164,
        url: `https://wa.me/${phone.waDigits}`,
        placement,
        confidence: CHANNEL_CONFIDENCE.whatsapp,
        evidence: [{ location: `html:${placement}:a[href]`, detail: `wa.me link (${label || 'unlabeled'})` }],
      });
      return;
    }

    if (/^(mailto:)/i.test(href)) {
      const email = href.replace(/^mailto:/i, '').split('?')[0]?.toLowerCase() ?? '';
      if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return;
      push({
        kind: 'email',
        value: email,
        url: `mailto:${email}`,
        placement,
        confidence: CHANNEL_CONFIDENCE.email,
        evidence: [{ location: `html:${placement}:a[href^=mailto]`, detail: `mailto (${label || 'unlabeled'})` }],
      });
      return;
    }

    if (/^tel:/i.test(href)) {
      const phone = normalizeAlgerianPhone(href.replace(/^tel:/i, '').replace(/[^+0-9]/g, ''));
      if (!phone) return;
      push({
        kind: 'phone',
        value: phone.e164,
        url: `tel:${phone.e164}`,
        placement,
        confidence: CHANNEL_CONFIDENCE.phone,
        evidence: [{ location: `html:${placement}:a[href^=tel]`, detail: `tel link (${phone.kind})` }],
      });
      return;
    }

    const handle = normalizeHandle(href);
    if (!handle) return;
    if (handle.network === 'whatsapp' || handle.network === 'messenger') {
      push({
        kind: handle.network === 'whatsapp' ? 'whatsapp' : 'messenger',
        value: handle.value,
        url: handle.profileUrl,
        placement,
        confidence: CHANNEL_CONFIDENCE[handle.network === 'whatsapp' ? 'whatsapp' : 'messenger'],
        evidence: [
          {
            location: `html:${placement}:a[href]`,
            detail: `${handle.network} link (${handle.viaId ? 'numeric id' : handle.value})`,
          },
        ],
      });
      return;
    }
    const kind: ChannelId =
      handle.network === 'facebook' ? 'facebook' : handle.network === 'instagram' ? 'instagram' : 'tiktok';
    push({
      kind,
      value: handle.value,
      url: handle.profileUrl,
      placement,
      confidence: CHANNEL_CONFIDENCE[kind],
      evidence: [{ location: `html:${placement}:a[href]`, detail: `${kind} profile link` }],
    });
  });

  // Raw text scan: phones / handles that appear outside anchors, or inside JS payloads.
  const visibleText = $('body').text().slice(0, input.textLimit ?? 600_000);
  const scriptText = $('script').text().slice(0, 200_000);
  const haystack = `${visibleText}\n${scriptText}`;

  for (const phone of extractAllAlgerianPhones(haystack)) {
    const existing = found.find((channel) => channel.value === phone.e164 && channel.kind === 'whatsapp');
    if (existing) continue;
    push({
      kind: 'phone',
      value: phone.e164,
      url: `tel:${phone.e164}`,
      placement: 'body',
      confidence: 0.7,
      evidence: [{ location: 'html:body:text', detail: `DZ ${phone.kind} number in page text` }],
    });
  }

  for (const handle of extractHandles(haystack)) {
    const kind: ChannelId =
      handle.network === 'whatsapp'
        ? 'whatsapp'
        : handle.network === 'messenger'
          ? 'messenger'
          : handle.network;
    // Anchors were scanned first, so an already-known channel keeps its higher
    // confidence; script/JSON payloads are where merchants hide their number.
    push({
      kind,
      value: handle.value,
      url: handle.profileUrl,
      placement: 'body',
      confidence: handle.network === 'whatsapp' ? 0.7 : 0.75,
      evidence: [{ location: 'html:body:text', detail: `${handle.network} link in page text/script` }],
    });
  }

  for (const email of extractEmails(haystack)) {
    push({
      kind: 'email',
      value: email,
      url: `mailto:${email}`,
      placement: 'body',
      confidence: 0.55,
      evidence: [{ location: 'html:body:text', detail: 'email address in page text' }],
    });
  }

  // Prefer higher confidence when the same value was found twice on the same channel.
  return uniqueBy(
    found.sort((a, b) => b.confidence - a.confidence),
    (channel) => `${channel.kind}:${channel.value}`,
  );
}

export function contactSignals(channels: readonly ContactChannel[]): {
  key: string;
  value: string;
  confidence: number;
  evidence: Evidence[];
}[] {
  return channels.map((channel) => ({
    key: `contact:${channel.kind}`,
    value: channel.value,
    confidence: channel.confidence,
    evidence: channel.evidence,
  }));
}

export function bestChannelOfNetwork(
  channels: readonly ContactChannel[],
  kind: ChannelId,
): ContactChannel | null {
  const candidates = channels.filter((channel) => channel.kind === kind);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, current) => (current.confidence > best.confidence ? current : best));
}

export function normalizedHandles(channels: readonly ContactChannel[]): NormalizedHandle[] {
  const out: NormalizedHandle[] = [];
  for (const channel of channels) {
    if (channel.kind === 'facebook' || channel.kind === 'instagram' || channel.kind === 'tiktok' || channel.kind === 'messenger') {
      const handle = normalizeHandle(channel.url, channel.kind === 'facebook' ? 'facebook' : channel.kind);
      if (handle) out.push(handle);
    }
  }
  return out;
}
