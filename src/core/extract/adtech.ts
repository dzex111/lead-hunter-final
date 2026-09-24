import type { Evidence } from '@/core/types';

/**
 * Ad-tech detector. Pure string matching over already-fetched HTML — no
 * third-party scripts are executed and no pixel is fired by this engine.
 */
export interface AdTechHit {
  id: string;
  label: string;
  /** Signals a Conversions API / server-side setup hint. */
  serverSide?: boolean;
  matched: string;
  evidence: Evidence;
}

interface AdTechRule {
  id: string;
  label: string;
  pattern: RegExp;
  serverSide?: boolean;
}

const RULES: readonly AdTechRule[] = [
  { id: 'meta_pixel', label: 'Meta Pixel', pattern: /connect\.facebook\.net\/[^"']*fbevents\.js|fbq\(\s*['"]init['"]/i },
  { id: 'meta_pixel_advanced', label: 'Meta Pixel (advanced matching)', pattern: /fbq\(\s*['"]init['"]\s*,\s*['"][^'"]+['"]\s*,\s*\{/i },
  { id: 'meta_capi', label: 'Meta Conversions API hint', pattern: /graph\.facebook\.com\/v\d+\.\d+\/[^"'/]+\/events|capi|conversions[_ -]?api/i, serverSide: true },
  { id: 'tiktok_pixel', label: 'TikTok Pixel', pattern: /analytics\.tiktok\.com|ttq\.load\(/i },
  { id: 'tiktok_events', label: 'TikTok Events API hint', pattern: /business-api\.tiktok\.com|events\/v\d+\/pixel/i, serverSide: true },
  { id: 'ga4', label: 'Google Analytics 4', pattern: /gtag\/js\?id=G-[A-Z0-9]{6,}|G-[A-Z0-9]{8,}/i },
  { id: 'gtm', label: 'Google Tag Manager', pattern: /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]{5,}/i },
  { id: 'snap_pixel', label: 'Snapchat Pixel', pattern: /sc-static\.net\/scevent\.min\.js|snaptr\(\s*['"]init['"]/i },
  { id: 'google_ads', label: 'Google Ads conversion', pattern: /googleads\.g\.doubleclick\.net|AW-[0-9]{9,}/i },
  { id: 'hotjar', label: 'Hotjar', pattern: /static\.hotjar\.com/i },
  { id: 'klaviyo', label: 'Klaviyo', pattern: /static\.klaviyo\.com|klaviyo\.js/i },
  { id: 'crisp_chat', label: 'Crisp chat', pattern: /client\.crisp\.chat/i },
  { id: 'tawk_chat', label: 'Tawk.to chat', pattern: /embed\.tawk\.to/i },
];

export function detectAdTech(html: string, location = 'html'): AdTechHit[] {
  const hits: AdTechHit[] = [];
  for (const rule of RULES) {
    const match = html.match(rule.pattern);
    if (!match) continue;
    hits.push({
      id: rule.id,
      label: rule.label,
      ...(rule.serverSide === true ? { serverSide: true } : {}),
      matched: (match[0] ?? '').slice(0, 80),
      evidence: { location, detail: `${rule.label}: ${(match[0] ?? '').slice(0, 60)}` },
    });
  }
  return hits;
}

export function adTechFlags(hits: readonly AdTechHit[]): string[] {
  return Array.from(new Set(hits.map((hit) => hit.id)));
}
