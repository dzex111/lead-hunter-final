import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { canonicalizeUrl, extractUrlsFromText, sameEtld1 } from '@/core/normalize/url';
import { extractAllAlgerianPhones, normalizeAlgerianPhone, extractAlgerianPhone } from '@/core/normalize/phone';
import { extractHandles, normalizeHandle, extractEmails } from '@/core/normalize/handles';
import { jaroWinkler, matchKey, normalizeText, tokenSetSimilarity, tokens } from '@/core/normalize/text';
import { detectLanguage } from '@/core/normalize/lang';

describe('URL canonicalization', () => {
  it('is idempotent (property)', () => {
    fc.assert(
      fc.property(
        fc.webUrl({ validSchemes: ['http', 'https'] }).filter((url) => !url.includes('?utm') && url.length < 120),
        (url) => {
          const first = canonicalizeUrl(url);
          const second = canonicalizeUrl(first.canonical);
          expect(second.canonical).toBe(first.canonical);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('strips www, tracking params, fragments and sorts params', () => {
    const canonical = canonicalizeUrl(
      'https://WWW.Example.COM/Product/1/?utm_source=fb&fbclid=abc&b=2&a=1#section',
    );
    expect(canonical.canonical).toBe('https://example.com/Product/1?a=1&b=2');
    expect(canonical.etld1).toBe('example.com');
  });

  it('keeps platform subdomains as distinct identities', () => {
    const a = canonicalizeUrl('https://shopone.youcan.shop/');
    const b = canonicalizeUrl('https://shoptwo.youcan.shop/');
    expect(a.host).not.toBe(b.host);
    expect(a.isSubdomainOfPlatformHost).toBe(true);
    const shopify = canonicalizeUrl('https://brand.myshopify.com/products.json');
    expect(shopify.isSubdomainOfPlatformHost).toBe(true);
    // myshopify.com is a private suffix: every store keeps its own identity.
    expect(shopify.etld1).toBe('brand.myshopify.com');
    expect(canonicalizeUrl('https://other.myshopify.com/').etld1).not.toBe(shopify.etld1);
  });

  it('extracts bare domains and dedupes urls from text', () => {
    const urls = extractUrlsFromText('شوف www.boutique-dz.dz و https://store.youcan.shop/p/1?utm_source=x');
    expect(urls).toContain('https://boutique-dz.dz/');
    expect(urls).toContain('https://store.youcan.shop/p/1');
  });

  it('compares eTLD+1 across subdomains', () => {
    expect(sameEtld1('https://a.example.dz/x', 'https://b.example.dz/y')).toBe(true);
    expect(sameEtld1('https://a.example.dz', 'https://a.other.dz')).toBe(false);
  });
});

describe('Algerian phone normalization', () => {
  it('normalizes every accepted notation to E.164', () => {
    const variants = ['0555123456', '0770 12 34 56', '+213661234567', '00213 551 23 45 67', '0555.12.34.56', '٠٧٧٠١٢٣٤٥٦'];
    const numbers = variants.map((value) => normalizeAlgerianPhone(value, { requireMobile: true }));
    expect(numbers.every((number) => number !== null)).toBe(true);
    expect(numbers.map((number) => number?.e164)).toEqual([
      '+213555123456',
      '+213770123456',
      '+213661234567',
      '+213551234567',
      '+213555123456',
      '+213770123456',
    ]);
  });

  it('round-trips the national number (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 10000000, max: 99999999 }),
        fc.constantFrom('5', '6', '7'),
        (rest, prefix) => {
          const national = `0${prefix}${rest}`;
          const normalized = normalizeAlgerianPhone(national, { requireMobile: true });
          expect(normalized).not.toBeNull();
          expect(normalized?.e164).toBe(`+213${prefix}${rest}`);
          expect(normalized?.waDigits).toBe(`213${prefix}${rest}`);
          // round-trip through E.164
          expect(normalizeAlgerianPhone(normalized?.e164 ?? '')?.national).toBe(`${prefix}${rest}`);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('separates landlines from mobiles and rejects invalid input', () => {
    expect(normalizeAlgerianPhone('021234567')?.kind).toBe('landline');
    expect(normalizeAlgerianPhone('021234567', { requireMobile: true })).toBeNull();
    expect(normalizeAlgerianPhone('12345')).toBeNull();
    expect(normalizeAlgerianPhone('+33612345678')).toBeNull();
    expect(normalizeAlgerianPhone('not a phone')).toBeNull();
    expect(extractAlgerianPhone('اتصل بنا ٠٧٧٠١٢٣٤٥٦ شكرا')?.e164).toBe('+213770123456');
    expect(extractAllAlgerianPhones('0770123456 / 0770123456')).toHaveLength(1);
  });
});

describe('handles and emails', () => {
  it('normalizes FB page ids, usernames and instagram profiles', () => {
    expect(normalizeHandle('https://www.facebook.com/profile.php?id=100012345')?.key).toBe('facebook:page_id:100012345');
    expect(normalizeHandle('https://facebook.com/BoutiqueDZ/')?.key).toBe('facebook:boutiquedz');
    expect(normalizeHandle('https://instagram.com/beldi.beauty/?hl=fr')?.value).toBe('beldi.beauty');
    expect(normalizeHandle('https://m.me/boutiquedz')?.network).toBe('messenger');
    expect(normalizeHandle('https://wa.me/213770123456')?.key).toBe('whatsapp:+213770123456');
    expect(normalizeHandle('https://www.facebook.com/pages/Boutique-DZ/1234')?.network).toBe('facebook');
    expect(normalizeHandle('https://facebook.com/marketplace')).toBeNull();
  });

  it('extracts handles and emails from a blob', () => {
    const blob = 'site: wa.me/213551234567 ig: https://instagram.com/abaya.dz fb https://facebook.com/abayadz mail: contact@abaya-dz.dz';
    const handles = extractHandles(blob).map((handle) => handle.key);
    expect(handles).toContain('whatsapp:+213551234567');
    expect(handles).toContain('instagram:abaya.dz');
    expect(handles).toContain('facebook:abayadz');
    expect(extractEmails(blob)).toEqual(['contact@abaya-dz.dz']);
  });
});

describe('text normalization', () => {
  it('is idempotent for normalizeText and matchKey (property)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 60 }), (value) => {
        const once = normalizeText(value);
        expect(normalizeText(once)).toBe(once);
        const key = matchKey(value);
        expect(matchKey(key)).toBe(key);
      }),
      { numRuns: 200 },
    );
  });

  it('unifies alef/ya/ta-marbuta, strips tashkeel and Latin accents for matching', () => {
    expect(matchKey('أَحْذِيَةٌ')).toBe(matchKey('احذيه'));
    expect(matchKey('Boutique Élégante')).toBe('boutique elegante');
    expect(matchKey('ملابــس')).toBe('ملابس');
    expect(tokens('Paiement à la livraison').length).toBeGreaterThan(2);
  });

  it('scores similar names high and unrelated names low', () => {
    expect(jaroWinkler('Beldi Beauty', 'Beldi  Beauté')).toBeGreaterThan(0.9);
    expect(tokenSetSimilarity('Nour Boutique DZ', 'Boutique Nour')).toBeGreaterThan(0.8);
    expect(tokenSetSimilarity('Nour Boutique', 'Tech DZ')).toBeLessThan(0.2);
  });
});

describe('language and dialect detection', () => {
  it('detects Darija, MSA, French, English and mixed', () => {
    expect(detectLanguage('واش راك تحوس تبيع بزاف؟ راني هنا نجرب').dominant).toBe('ar_dz');
    expect(detectLanguage('يمكنك تقديم الخدمة للعميل من خلال المنصة التي يوجد بها').dominant).toBe('ar_msa');
    expect(detectLanguage('Paiement à la livraison, livraison à domicile pour toutes les commandes').dominant).toBe('fr');
    expect(detectLanguage('Free shipping on your order, add to cart and checkout now').dominant).toBe('en');
    const distribution = detectLanguage('Boutique ملابس DZ واش راك تبيع online shop livraison');
    expect(distribution.dominant).toBe('mixed');
    const total =
      distribution.ar_dz + distribution.ar_msa + distribution.fr + distribution.en + distribution.mixed;
    expect(total).toBeCloseTo(1, 5);
  });
});
