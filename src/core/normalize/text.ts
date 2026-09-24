import { normalizeDigits } from '@/core/normalize/phone';

/**
 * Text normalization.
 * `normalizeText` keeps a readable form (NFKC, no control chars, no tashkeel,
 * Latin accents stripped) while `matchKey` produces an aggressively unified
 * form used only for matching/lexicon lookup (alef/ya/ta-marbuta unified,
 * digits ASCII, punctuation removed, whitespace collapsed).
 */

const TASHKEEL = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u08D3-\u08E1\u08E3-\u08FF\uFE70-\uFE7F]/g;
const TATWEEL = /\u0640/g;

export function normalizeUnicode(input: string): string {
  return input.normalize('NFKC');
}

export function stripArabicDiacritics(input: string): string {
  return input.replace(TASHKEEL, '').replace(TATWEEL, '');
}

export function unifyArabicLetters(input: string): string {
  return input
    .replace(/[\u0622\u0623\u0625\u0627\u0671\u0672\u0673]/g, '\u0627') // alef variants -> ا
    .replace(/\u0649/g, '\u064A') // alef maksura -> ي
    .replace(/\u0626/g, '\u064A') // ya hamza -> ي
    .replace(/\u0624/g, '\u0648') // waw hamza -> و
    .replace(/\u0629/g, '\u0647'); // ta marbuta -> ه (matching only)
}

export function stripLatinAccents(input: string): string {
  return input.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\u00df/g, 'ss');
}

export function normalizeText(input: string): string {
  return stripArabicDiacritics(normalizeUnicode(input))
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .normalize('NFC')
    .replace(/[ \t\u00A0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function matchKey(input: string): string {
  const base = stripLatinAccents(unifyArabicLetters(stripArabicDiacritics(normalizeUnicode(input))))
    .toLowerCase()
    .replace(/[\u060C\u061B\u061F\u066A-\u066D.,!?;:"'`()\[\]{}<>/\\|*+=_~^%$#@&]/g, ' ')
    .replace(/[\u064B-\u065F]/g, '');
  const asciiDigits = normalizeDigits(base);
  return asciiDigits.replace(/\s+/g, ' ').trim();
}

export function tokens(input: string): string[] {
  return matchKey(input)
    .split(' ')
    .filter((token) => token.length > 1 || /[0-9\u0600-\u06FF]/.test(token));
}

export function slugify(input: string): string {
  return stripLatinAccents(normalizeUnicode(input).toLowerCase())
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Cleans a merchant display name for outreach: trims platform noise and emoji runs. */
export function cleanMerchantName(input: string): string {
  const base = normalizeText(input)
    .replace(/\[\s*|\s*\]/g, '')
    .replace(/[|–—]\s*(boutique|store|shop|dz|algerie)\s*$/i, '')
    .replace(/\s*\|\s*.*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return base.slice(0, 60);
}

/** Jaro-Winkler similarity on normalized strings (used by entity resolution). */
export function jaroWinkler(a: string, b: string, prefixScale = 0.1): number {
  const s1 = matchKey(a);
  const s2 = matchKey(b);
  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;
  const matchDistance = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);
  const s1Matches = new Array<boolean>(s1.length).fill(false);
  const s2Matches = new Array<boolean>(s2.length).fill(false);
  let matches = 0;
  for (let i = 0; i < s1.length; i += 1) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, s2.length);
    for (let j = start; j < end; j += 1) {
      if (s2Matches[j] === true) continue;
      if (s1.charAt(i) !== s2.charAt(j)) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < s1.length; i += 1) {
    if (s1Matches[i] !== true) continue;
    while (s2Matches[k] !== true) k += 1;
    if (s1.charAt(i) !== s2.charAt(k)) transpositions += 1;
    k += 1;
  }
  const jaro =
    (matches / s1.length + matches / s2.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  const maxPrefix = Math.min(4, s1.length, s2.length);
  while (prefix < maxPrefix && s1.charAt(prefix) === s2.charAt(prefix)) prefix += 1;
  return jaro + prefix * prefixScale * (1 - jaro);
}

/** Token-set similarity (order-insensitive, partial overlap tolerant). */
export function tokenSetSimilarity(a: string, b: string): number {
  const setA = new Set(tokens(a));
  const setB = new Set(tokens(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  const dice = (2 * intersection) / (setA.size + setB.size);
  const containment = intersection / Math.min(setA.size, setB.size);
  return Math.max(dice, containment * 0.95);
}
