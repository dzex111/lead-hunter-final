import { extractEmails, extractHandles } from '@/core/normalize/handles';
import { extractAllAlgerianPhones } from '@/core/normalize/phone';
import { canonicalizeUrl, extractUrlsFromText } from '@/core/normalize/url';
import { cleanMerchantName } from '@/core/normalize/text';
import type { RawCandidate } from '@/core/types';
import { uniqueBy } from '@/core/util';
import { discoverFromDirectoryHtml } from '@/adapters/sources/directory';
import { asAsyncIterable, SourceNotReadyError, type DiscoverySource } from '@/adapters/sources/types';

/**
 * Manual surfaces: whatever the operator legitimately obtains (their own
 * research, public Ad Library UI, pasted lists) enters the pipeline here.
 * No scraping of logged-in UIs ever happens in this adapter.
 */
export function manualPasteSource(): DiscoverySource {
  const id = 'manual_paste';
  return {
    id,
    label: 'Manual paste (any text blob)',
    capabilities: {
      network: false,
      paidApi: false,
      requiresCredentials: false,
      robotsRespect: true,
      costUnitsPerCall: 0,
      note: 'Extracts URLs, handles and phones from pasted text. Zero network calls.',
    },
    ensureReady: (ctx) => {
      if ((ctx.params['text'] ?? '').trim().length === 0) {
        throw new SourceNotReadyError(id, 'pass --text "<pasted blob>" or pipe text through stdin');
      }
    },
    discover(ctx) {
      const text = ctx.params['text'] ?? '';
      const urls = extractUrlsFromText(text);
      const phones = extractAllAlgerianPhones(text).map((phone) => phone.e164);
      const handles = extractHandles(text);
      const emails = extractEmails(text);

      const candidates: RawCandidate[] = urls.map((url) => {
        const canonical = canonicalizeUrl(url);
        const lower = text.toLowerCase();
        const index = lower.indexOf(canonical.host);
        const snippet = index >= 0 ? text.slice(Math.max(0, index - 80), index + 120) : '';
        const cleanedName = cleanMerchantName(snippet);
        return {
          sourceId: id,
          url: canonical.canonical,
          ...(cleanedName.length > 0 ? { name: cleanedName } : {}),
          phones,
          emails,
          handles: handles.map((handle) => ({ network: handle.network as 'facebook' | 'instagram' | 'tiktok', value: handle.value }))
            .filter((handle) => handle.network === 'facebook' || handle.network === 'instagram' || handle.network === 'tiktok'),
          provenance: { origin: 'paste', chars: text.length },
          costUnits: 0,
        };
      });

      if (candidates.length === 0) {
        candidates.push({
          sourceId: id,
          phones,
          emails,
          handles: handles
            .filter((handle) => ['facebook', 'instagram', 'tiktok'].includes(handle.network))
            .map((handle) => ({ network: handle.network as 'facebook' | 'instagram' | 'tiktok', value: handle.value })),
          provenance: { origin: 'paste', chars: text.length, note: 'no URL found — identities only' },
          costUnits: 0,
        });
      }
      return asAsyncIterable(uniqueBy(candidates, (candidate) => candidate.url ?? candidate.phones?.join(',') ?? ''));
    },
  };
}

export function manualAddSource(): DiscoverySource {
  const id = 'manual_add';
  return {
    id,
    label: 'Manual add (referral / operator known merchant)',
    capabilities: {
      network: false,
      paidApi: false,
      requiresCredentials: false,
      robotsRespect: true,
      costUnitsPerCall: 0,
      note: 'Operator-entered lead with referral provenance.',
    },
    ensureReady: (ctx) => {
      if (!(ctx.params['url'] ?? ctx.params['phone'] ?? '').trim()) {
        throw new SourceNotReadyError(id, 'provide --url and/or --phone');
      }
    },
    discover(ctx) {
      const url = ctx.params['url'];
      const phone = ctx.params['phone'];
      const candidate: RawCandidate = {
        sourceId: id,
        ...(url ? { url } : {}),
        ...(phone ? { phones: [phone] } : {}),
        name: ctx.params['name'],
        notes: ctx.params['notes'],
        provenance: {
          origin: 'manual_add',
          referredBy: ctx.params['referred_by'] ?? null,
          operator: ctx.config.operator,
        },
        costUnits: 0,
      };
      return asAsyncIterable([candidate]);
    },
  };
}

export function socialPasteSource(): DiscoverySource {
  const id = 'social_paste';
  return {
    id,
    label: 'Social paste (operator-pasted FB/IG/TikTok profiles, no scraping)',
    capabilities: {
      network: false,
      paidApi: false,
      requiresCredentials: false,
      robotsRespect: true,
      costUnitsPerCall: 0,
      note: 'Normalizes handles and stores operator annotations (has_whatsapp, sells_cod, is_advertiser, niche).',
    },
    ensureReady: (ctx) => {
      if ((ctx.params['handles'] ?? '').trim().length === 0) {
        throw new SourceNotReadyError(id, 'pass --handles "<url|handle>[,<url|handle>...]"');
      }
    },
    discover(ctx) {
      const raw = (ctx.params['handles'] ?? '').split(/[\n,]/).map((value) => value.trim()).filter(Boolean);
      const annotations: Record<string, string | boolean | number> = {
        has_whatsapp: ctx.params['has_whatsapp'] === 'true',
        sells_cod: ctx.params['sells_cod'] === 'true',
        is_advertiser: ctx.params['is_advertiser'] === 'true',
        niche: ctx.params['niche'] ?? '',
        notes: ctx.params['notes'] ?? '',
      };
      const candidates: RawCandidate[] = [];
      for (const value of raw) {
        const handles = extractHandles(value);
        const handle = handles[0];
        if (!handle) continue;
        const facebook: 'facebook' | 'instagram' | 'tiktok' | null =
          handle.network === 'facebook' ? 'facebook' : handle.network === 'instagram' ? 'instagram' : handle.network === 'tiktok' ? 'tiktok' : null;
        candidates.push({
          sourceId: id,
          name: handle.value,
          handles: facebook ? [{ network: facebook, value: handle.value }] : [],
          provenance: { origin: 'social_paste', profileUrl: handle.profileUrl, viaId: handle.viaId },
          annotations,
          costUnits: 0,
        });
      }
      if (candidates.length === 0) {
        throw new SourceNotReadyError(id, 'none of the pasted values looked like a Facebook/Instagram/TikTok profile');
      }
      return asAsyncIterable(candidates);
    },
  };
}

/** Read-only ORDELY customers CSV ingestion (operator exports it; no live coupling). */
export function csvImportSource(reader: (path: string) => string): DiscoverySource {
  const id = 'csv_import';
  return {
    id,
    label: 'CSV import (column mapping + validation report)',
    capabilities: {
      network: false,
      paidApi: false,
      requiresCredentials: false,
      robotsRespect: true,
      costUnitsPerCall: 0,
      note: 'Maps columns (url, name, phone, instagram...) and reports skipped rows.',
    },
    ensureReady: (ctx) => {
      if (!(ctx.params['path'] ?? '').trim()) throw new SourceNotReadyError(id, 'pass --path ./leads.csv');
    },
    discover(ctx) {
      const content = reader(ctx.params['path'] ?? '');
      const report = parseCsv(content);
      const mapped = report.rows.map((row) => ({
        row,
        value: pickColumn(row, [
          ctx.params['url_column'] ?? 'url',
          'site',
          'website',
          'lien',
          'store',
        ]),
      }));
      const candidates: RawCandidate[] = mapped.map(({ row, value }) => {
        const canonical = value ? tryCanonical(value) : null;
        const phone = pickColumn(row, ['phone', 'telephone', 'tel', 'whatsapp']);
        const ig = pickColumn(row, ['instagram', 'ig']);
        return {
          sourceId: id,
          ...(canonical ? { url: canonical } : {}),
          ...(phone ? { phones: [phone] } : {}),
          name: pickColumn(row, ['name', 'nom', 'boutique', 'store_name']),
          handles: ig ? [{ network: 'instagram' as const, value: ig.replace(/^@/, '') }] : [],
          provenance: {
            origin: 'csv_import',
            file: ctx.params['path'] ?? '',
            validationWarnings: report.warnings.length,
          },
          costUnits: 0,
        };
      });
      return asAsyncIterable(candidates.filter((candidate) => candidate.url || candidate.phones?.length));
    },
  };
}

export interface CsvReport {
  rows: Record<string, string>[];
  warnings: string[];
  delimiter: string;
}

export function parseCsv(content: string, delimiter = ','): CsvReport {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const warnings: string[] = [];
  if (lines.length === 0) return { rows: [], warnings: ['empty file'], delimiter };
  const header = (lines[0] ?? '').split(delimiter).map((value) => value.trim().toLowerCase());
  const rows: Record<string, string>[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line, delimiter);
    if (cells.length !== header.length) {
      warnings.push(`row with ${cells.length} cells but ${header.length} columns skipped: ${line.slice(0, 40)}`);
      continue;
    }
    const row: Record<string, string> = {};
    header.forEach((key, index) => {
      row[key] = (cells[index] ?? '').trim();
    });
    rows.push(row);
  }
  return { rows, warnings, delimiter };
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === delimiter && !inQuotes) {
      out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  out.push(current);
  return out;
}

function pickColumn(row: Record<string, string>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = row[name.toLowerCase()];
    if (value && value.length > 0) return value;
  }
  return undefined;
}

function tryCanonical(value: string): string | null {
  try {
    return canonicalizeUrl(value.startsWith('http') ? value : `https://${value}`).canonical;
  } catch {
    return null;
  }
}

/** Ad Library operator paste: advertiser page IDs / URLs / lists. */
export function adLibraryManualSource(): DiscoverySource {
  const id = 'ad_library_manual';
  return {
    id,
    label: 'Ad Library (manual operator paste)',
    capabilities: {
      network: false,
      paidApi: false,
      requiresCredentials: false,
      robotsRespect: true,
      costUnitsPerCall: 0,
      note: 'Records is_advertiser evidence with first_seen/last_seen. NO Facebook UI scraping.',
    },
    ensureReady: (ctx) => {
      if ((ctx.params['advertisers'] ?? '').trim().length === 0) {
        throw new SourceNotReadyError(id, 'paste advertiser page IDs or URLs from the public Ad Library UI');
      }
    },
    discover(ctx) {
      const raw = (ctx.params['advertisers'] ?? '').split(/[\n,;]/).map((value) => value.trim()).filter(Boolean);
      const observedAt = ctx.clock.now().toISOString();
      const candidates: RawCandidate[] = [];
      for (const value of raw) {
        const handles = extractHandles(value).filter((handle) => handle.network === 'facebook');
        const idMatch = value.match(/^\d{5,}$/);
        const pageId = idMatch?.[0] ?? null;
        const page = handles[0];
        if (!page && !pageId) continue;
        candidates.push({
          sourceId: id,
          name: page?.value ?? `page:${pageId}`,
          handles: page ? [{ network: 'facebook', value: page.value }] : [],
          provenance: {
            origin: 'ad_library_manual',
            pageId,
            adLibraryUrl: pageId ? `https://www.facebook.com/ads/library/?id=${pageId}` : null,
            firstSeen: observedAt,
            lastSeen: observedAt,
          },
          annotations: { is_advertiser: true, source: 'ad_library_manual' },
          costUnits: 0,
        });
      }
      if (candidates.length === 0) {
        throw new SourceNotReadyError(id, 'no advertiser page IDs or Facebook URLs recognised');
      }
      return asAsyncIterable(candidates);
    },
  };
}

/** Generic directory ingester for lists the operator obtains legitimately. */
export function directoryImportSource(): DiscoverySource {
  const id = 'directory_import';
  return {
    id,
    label: 'Directory import (HTML/CSV, robots-aware)',
    capabilities: {
      network: true,
      paidApi: false,
      requiresCredentials: false,
      robotsRespect: true,
      costUnitsPerCall: 1,
      note: 'Fetches one page (robots-checked) and extracts merchant-looking links.',
    },
    ensureReady: (ctx) => {
      if (!(ctx.params['url'] ?? '').trim()) throw new SourceNotReadyError(id, 'pass --url <directory page>');
    },
    async *discover(ctx) {
      const url = ctx.params['url'] ?? '';
      if (ctx.dryRun) {
        const preview: RawCandidate = {
          sourceId: id,
          url,
          provenance: { origin: 'directory_import', dryRun: true },
          costUnits: 0,
        };
        yield preview;
        return;
      }
      if (!ctx.budget.consume(1)) {
        ctx.logger.warn({ url }, 'directory_import budget exhausted');
        return;
      }
      const response = await ctx.http.fetch({ url, purpose: 'directory' });
      const entries = discoverFromDirectoryHtml(url, response.body, response.meta.finalUrl);
      ctx.logger.info({ url, found: entries.length, status: response.meta.status }, 'directory imported');
      for (const entry of entries) {
        const candidate: RawCandidate = {
          sourceId: id,
          url: entry.url,
          name: entry.label,
          provenance: {
            origin: 'directory_import',
            directoryUrl: url,
            contentHash: response.meta.contentHash,
          },
          costUnits: 0,
        };
        yield candidate;
      }
    },
  };
}
