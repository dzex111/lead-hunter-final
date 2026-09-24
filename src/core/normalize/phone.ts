import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

/**
 * Algerian phone normalization.
 * Accepted inputs: 0X XX XX XX XX, 05XX..., 00213..., +213..., spaces/dots/dashes,
 * Arabic-Indic digits. Output: E.164 (+2135XXXXXXXX) plus a mobile/landline tag.
 * Mobile prefixes 5/6/7; landlines start with 2/3/4 (rejected when caller demands mobile).
 */
export type PhoneKind = 'mobile' | 'landline';

export interface NormalizedPhone {
  e164: string;
  national: string;
  kind: PhoneKind;
  country: 'DZ';
  /** WhatsApp-ready digits (E.164 without the leading '+'). */
  waDigits: string;
}

const ARABIC_INDIC_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g;

export function normalizeDigits(input: string): string {
  return input
    .replace(ARABIC_INDIC_DIGITS, (char) => {
      const code = char.codePointAt(0) ?? 0;
      if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
      return String(code - 0x06f0);
    })
    .replace(/[٠-٩]/g, (char) => String(char.codePointAt(0)! - 0x0660));
}

export function normalizeAlgerianPhone(
  input: string,
  options: { defaultCountry?: CountryCode; requireMobile?: boolean } = {},
): NormalizedPhone | null {
  if (!input) return null;
  const digitsOnly = normalizeDigits(input);
  const cleaned = digitsOnly.replace(/[\s.\u00A0\u2011\u2012\u2013\u2014\-()/]/g, '');
  if (!/^[+0-9]+$/.test(cleaned)) return null;

  let candidate = cleaned;
  if (candidate.startsWith('00')) candidate = `+${candidate.slice(2)}`;
  if (candidate.startsWith('213') && !candidate.startsWith('+')) candidate = `+${candidate}`;

  const parsed = parsePhoneNumberFromString(candidate, options.defaultCountry ?? 'DZ');
  if (!parsed || !parsed.isValid()) return null;
  if (parsed.country !== 'DZ') return null;

  const e164 = parsed.number;
  const national = parsed.nationalNumber;
  const prefix = national.charAt(0);
  const kind: PhoneKind = ['5', '6', '7'].includes(prefix) ? 'mobile' : 'landline';
  if (options.requireMobile === true && kind !== 'mobile') return null;

  return {
    e164,
    national,
    kind,
    country: 'DZ',
    waDigits: e164.replace('+', ''),
  };
}

/** Extracts the first DZ mobile number from a free-text blob. */
export function extractAlgerianPhone(input: string): NormalizedPhone | null {
  const digits = normalizeDigits(input);
  const matches = digits.match(/(?:\+?213|0)(?:\s|\.|-)?[5-7](?:[\s.\-]?\d){8}/g) ?? [];
  for (const match of matches) {
    const normalized = normalizeAlgerianPhone(match, { requireMobile: true });
    if (normalized) return normalized;
  }
  return null;
}

export function extractAllAlgerianPhones(input: string): NormalizedPhone[] {
  const digits = normalizeDigits(input);
  // 0 + 8 national digits (landline) or 0 + 9 (mobile) — both are covered by
  // allowing 8 further digit groups after the leading national digit.
  const matches = digits.match(/(?:\+?213|0)(?:\s|\.|-)?[2-7](?:[\s.\-]?\d){8}/g) ?? [];
  const out: NormalizedPhone[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const normalized = normalizeAlgerianPhone(match);
    if (!normalized) continue;
    if (seen.has(normalized.e164)) continue;
    seen.add(normalized.e164);
    out.push(normalized);
  }
  return out;
}

export function isAlgerianPhone(value: string): boolean {
  return normalizeAlgerianPhone(value) !== null;
}
