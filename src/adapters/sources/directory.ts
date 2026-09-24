import * as cheerio from 'cheerio';
import { MARKETPLACE_BLOCKLIST, NEWS_BLOCKLIST } from '@/core/data/lexicons';
import { safeCanonicalizeUrl } from '@/core/normalize/url';

/**
 * Pure HTML directory parsing (no network here): a directory row is a merchant
 * candidate when it links to an external site and carries a merchant-ish label.
 * Blocked: marketplaces, social networks, news and directories themselves.
 */
export interface DirectoryEntry {
  url: string;
  label: string;
  raw: string;
}

export const MARKETERS_LABEL_HINTS = [
  'boutique', 'shop', 'store', 'متجر', 'commander', 'boutique en ligne', 'paiement',
  'livraison', 'cash on delivery', 'cod', 'الدفع عند الاستلام', 'watch', 'parfum',
];

export function isExcludedDomain(url: string): boolean {
  const canonical = safeCanonicalizeUrl(url);
  if (!canonical) return true;
  const host = canonical.host;
  const blocked = [...MARKETPLACE_BLOCKLIST, ...NEWS_BLOCKLIST].some((needle) => host.includes(needle));
  return blocked;
}

export function discoverFromDirectoryHtml(
  directoryUrl: string,
  html: string,
  finalUrl = directoryUrl,
): DirectoryEntry[] {
  const $ = cheerio.load(html);
  const directoryHost = safeCanonicalizeUrl(finalUrl)?.host ?? '';
  const out: DirectoryEntry[] = [];

  $('a[href]').each((_index, element) => {
    const href = $(element).attr('href');
    if (!href) return;
    const canonical = safeCanonicalizeUrl(href, finalUrl);
    if (!canonical) return;
    if (canonical.host === directoryHost) return;
    if (isExcludedDomain(canonical.canonical)) return;
    const label = $(element).text().replace(/\s+/g, ' ').trim();
    const container = $(element).closest('li, tr, article, div').text().replace(/\s+/g, ' ').trim().slice(0, 200);
    const blob = `${label} ${container}`.toLowerCase();
    const hinted = MARKETERS_LABEL_HINTS.some((hint) => blob.includes(hint.toLowerCase()));
    if (!hinted && label.length < 3) return;
    out.push({ url: canonical.canonical, label: label.slice(0, 80), raw: container });
  });

  const seen = new Set<string>();
  return out.filter((entry) => {
    if (seen.has(entry.url)) return false;
    seen.add(entry.url);
    return true;
  });
}
