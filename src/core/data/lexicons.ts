import type { CategoryId } from '@/core/types';

/**
 * Lexicons are written in the *matching form* produced by
 * `normalize/normalizeText` + `matchKey` (Arabic: tashkeel/tatweel removed,
 * alef/ya/ta-marbuta unified; Latin: accent-free lowercase).
 */
export const CATEGORY_LEXICONS: Record<CategoryId, { ar: string[]; fr: string[]; en: string[] }> = {
  fashion: {
    ar: ['ملابس', 'قميص', 'قمصان', 'فساتين', 'فستان', 'بنطال', 'جينز', 'تيشيرت', 'حجاب', 'عبايه', 'جلابيه', 'سويت شيرت', 'بدله'],
    fr: ['vetement', 'vetements', 'robe', 'robes', 'chemise', 'jean', 'pantalon', 'manteau', 'abaya', 'hijab', 'mode femme', 'pret a porter'],
    en: ['clothing', 'dress', 'shirt', 'jeans', 'hoodie', 'fashion', 'apparel', 'abaya'],
  },
  shoes: {
    ar: ['احذيه', 'حذا', 'صباط', 'صندل', 'كعب', 'سنيكرز', 'جزمه'],
    fr: ['chaussure', 'chaussures', 'basket', 'baskets', 'sandale', 'escarpin', 'bottes', 'sneakers'],
    en: ['shoes', 'sneakers', 'sandals', 'boots', 'heels'],
  },
  beauty: {
    ar: ['مكياج', 'عطور', 'عطر', 'كريم', 'سيروم', 'ماسك', 'شعر', 'عنايه', 'مسك', 'روج', 'احمر شفاه'],
    fr: ['cosmetique', 'parfum', 'maquillage', 'creme', 'serum', 'soin', 'rouge a levres', 'cheveux', 'beaute'],
    en: ['cosmetics', 'perfume', 'makeup', 'skincare', 'serum', 'lipstick', 'beauty'],
  },
  phones_accessories: {
    ar: ['هاتف', 'هواتف', 'سماعه', 'شاحن', 'غطاء هاتف', 'كابل', 'ايفون', 'سامسونج', 'شاشه هاتف'],
    fr: ['telephone', 'smartphone', 'ecouteur', 'ecouteurs', 'chargeur', 'coque', 'cable', 'iphone', 'samsung', 'accessoire telephone'],
    en: ['phone', 'smartphone', 'earbuds', 'charger', 'phone case', 'cable', 'iphone', 'samsung'],
  },
  electronics: {
    ar: ['الكترونيات', 'تلفاز', 'شاشه', 'سماعات بلوتوث', 'ساعه ذكيه', 'طابعه', 'كاميرا', 'بلايستيشن'],
    fr: ['electronique', 'televiseur', 'tv', 'enceinte bluetooth', 'montre connectee', 'camera', 'imprimante', 'console'],
    en: ['electronics', 'tv', 'bluetooth speaker', 'smartwatch', 'camera', 'printer', 'console'],
  },
  home_kitchen: {
    ar: ['منزل', 'مطبخ', 'ادوات مطبخ', 'مقلايه', 'طنجره', 'مفارش', 'سجاد', 'ستائر', 'خلاط', 'منظفات'],
    fr: ['maison', 'cuisine', 'ustensile', 'poele', 'casserole', 'tapis', 'rideaux', 'mixeur', 'menage'],
    en: ['home', 'kitchen', 'cookware', 'pan', 'rug', 'curtains', 'blender', 'household'],
  },
  kids: {
    ar: ['اطفال', 'طفال', 'العاب', 'لعبه', 'حفاظات', 'ملابس اطفال', 'عربه اطفال'],
    fr: ['enfant', 'enfants', 'bebe', 'jouet', 'jouets', 'couches', 'poussette', 'vetement bebe'],
    en: ['kids', 'baby', 'toys', 'stroller', 'diapers', 'children'],
  },
  auto: {
    ar: ['سيارات', 'سياره', 'قطع غيار', 'اكسسوارات سياره', 'زيت محرك', 'اطارات'],
    fr: ['auto', 'automobile', 'voiture', 'piece auto', 'accessoire voiture', 'huile moteur', 'pneus'],
    en: ['auto', 'car', 'car parts', 'car accessories', 'motor oil', 'tires'],
  },
  health_supplements: {
    ar: ['مكملات', 'فيتامين', 'بروتين', 'حبوب', 'دايت', 'تنحيف', 'صحه', 'اعشاب'],
    fr: ['complement alimentaire', 'vitamine', 'proteine', 'minceur', 'regime', 'sante', 'plantes'],
    en: ['supplement', 'vitamin', 'protein', 'weight loss', 'health', 'herbal'],
  },
  jewelry_watches: {
    ar: ['مجوهرات', 'سلسله', 'خاتم', 'اسوره', 'ساعه', 'ذهب', 'فضه', 'اقراط'],
    fr: ['bijou', 'bijoux', 'collier', 'bague', 'bracelet', 'montre', 'or', 'argent', 'boucles oreilles'],
    en: ['jewelry', 'necklace', 'ring', 'bracelet', 'watch', 'gold', 'silver'],
  },
  other: {
    ar: ['منتجات', 'متجر', 'طلبات', 'توصيل'],
    fr: ['produit', 'produits', 'boutique', 'commande', 'livraison'],
    en: ['product', 'products', 'store', 'order', 'shipping'],
  },
};

/** Base-rate prior over categories (from operator market intuition; see docs/MATH.md). */
export const CATEGORY_PRIORS: Record<CategoryId, number> = {
  fashion: 0.26,
  shoes: 0.08,
  beauty: 0.17,
  phones_accessories: 0.12,
  electronics: 0.07,
  home_kitchen: 0.1,
  kids: 0.07,
  auto: 0.03,
  health_supplements: 0.05,
  jewelry_watches: 0.03,
  other: 0.02,
};

export const COD_PHRASES: { lang: 'ar' | 'fr' | 'en'; phrase: string; weight: number }[] = [
  { lang: 'fr', phrase: 'paiement a la livraison', weight: 3.6 },
  { lang: 'fr', phrase: 'paiement a la reception', weight: 3.0 },
  { lang: 'fr', phrase: 'payer a la livraison', weight: 2.6 },
  { lang: 'fr', phrase: 'livraison a domicile', weight: 1.6 },
  { lang: 'fr', phrase: 'livraison 58 wilayas', weight: 2.4 },
  { lang: 'fr', phrase: 'livraison partout en algerie', weight: 2.4 },
  { lang: 'fr', phrase: 'cash on delivery', weight: 2.0 },
  { lang: 'fr', phrase: 'retour gratuit', weight: 0.8 },
  { lang: 'ar', phrase: 'الدفع عند الاستلام', weight: 3.8 },
  { lang: 'ar', phrase: 'الدفع عند التسليم', weight: 3.2 },
  { lang: 'ar', phrase: 'الدفع في المنزل', weight: 2.8 },
  { lang: 'ar', phrase: 'الخلاص عند الاستلام', weight: 2.6 },
  { lang: 'ar', phrase: 'توصيل لكل الولايات', weight: 2.6 },
  { lang: 'ar', phrase: 'التوصيل مجاني', weight: 1.4 },
  { lang: 'ar', phrase: 'طلبيتك توصل', weight: 1.4 },
  { lang: 'en', phrase: 'cash on delivery', weight: 2.0 },
  { lang: 'en', phrase: 'cod available', weight: 1.8 },
  { lang: 'en', phrase: 'delivery all over algeria', weight: 2.2 },
];

export const CURRENCY_PATTERNS: { pattern: string; currency: string; weight: number }[] = [
  { pattern: '\\bdzd\\b', currency: 'DZD', weight: 2.2 },
  { pattern: '\\bda\\b', currency: 'DZD', weight: 1.1 },
  { pattern: 'dinars?', currency: 'DZD', weight: 1.6 },
  { pattern: 'دج', currency: 'DZD', weight: 2.2 },
  { pattern: 'د\\.?ج', currency: 'DZD', weight: 2.0 },
  { pattern: 'دينار', currency: 'DZD', weight: 1.8 },
  { pattern: '\\beur\\b|\\beuros?\\b', currency: 'EUR', weight: 0.4 },
];

/** Aggressive commercial spam terms: these hard-fail the messaging linter. */
export const SPAM_BLOCKLIST: string[] = [
  'cliquez ici',
  'cliquer ici',
  'offre limitee',
  'offre exceptionnelle',
  'gratuit a 100',
  '100% gratuit',
  'argent facile',
  'gagnez de l argent',
  'اضغط هنا',
  'ربح مضمون',
  'اربح المال',
  'مجاني 100',
  'فرصه لن تتكرر',
];

/** Softer terms that only raise a warning (still counted in the lint report). */
export const SPAM_WARNLIST: string[] = [
  'gratuit',
  'promo',
  'urgent',
  'garanti',
  'exclusif',
  'مجان',
  'عرض خاص',
  'عاجل',
  'مضمون',
];

export const DIALECT_MARKERS_AR_DZ: string[] = [
  'واش', 'راك', 'راه', 'راهم', 'تاع', 'بزاف', 'شحال', 'كاش', 'خلاص', 'بصح', 'مليح',
  'نتا', 'نحوس', 'خاطر', 'دوك', 'ياخي', 'درت', 'تجي', 'ماكاش', 'برك', 'زيد', 'وليد',
  'حوس', 'كيما', 'هكاك', 'شباب', 'دير', 'تشوف', 'نجرب', 'بالزاف', 'سيرتو',
];

export const MARKERS_AR_MSA: string[] = [
  'الذي', 'التي', 'هذا', 'هذه', 'يمكن', 'يوجد', 'نحن', 'يمكنك', 'أيضا', 'جدا',
  'الخدمة', 'المنتجات', 'العميل', 'الطلبات', 'بشكل', 'حيث', 'من خلال', 'إلى',
];

export const MARKERS_FR: string[] = [
  'le', 'la', 'les', 'des', 'une', 'vous', 'nous', 'avec', 'pour', 'est', 'sur',
  'livraison', 'paiement', 'commande', 'boutique', 'prix', 'produit', 'gratuit',
  'client', 'merci', 'bonjour',
];

export const MARKERS_EN: string[] = [
  'the', 'and', 'you', 'your', 'with', 'for', 'shipping', 'order', 'store',
  'price', 'product', 'free', 'thanks', 'hello', 'checkout',
];

/**
 * Marketplace / media / directory domains: excluded from discovery results by
 * the web_search adapter rules (we want merchant-owned storefronts).
 */
export const MARKETPLACE_BLOCKLIST: string[] = [
  'amazon.', 'aliexpress.', 'alibaba.', 'ebay.', 'temu.', 'shein.', 'jumia.',
  'olx.', 'ouedkniss.', 'facebook.', 'instagram.', 'tiktok.', 'youtube.',
  'twitter.', 'x.com', 'linkedin.', 'pinterest.', 'wikipedia.', 'reddit.',
  'yelp.', 'tripadvisor.', 'glovo.', 'yassir.', 'taobao.', 'etsy.', 'walmart.',
];

export const NEWS_BLOCKLIST: string[] = [
  'news', 'journal', 'presse', 'akhbar', 'echoroukonline', 'elwatan', 'liberte',
  'tsa-algerie', 'aps.dz', 'dw.com', 'bbc.', 'cnn.', 'forbes.',
];
