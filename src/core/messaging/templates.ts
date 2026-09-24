import type { ChannelId, LanguageId, PlatformId } from '@/core/types';

/**
 * Template catalogue.
 *
 * Dialect policy: Arabic bodies are light Algerian Darija (the language COD
 * merchants actually answer in), and each required template ships with an
 * Arabic-MSA and/or French variant so a merchant who writes French is never
 * addressed in a script they did not use. Variant selection is Thompson-sampled,
 * never hard-coded — see src/core/messaging/render.ts.
 */
export interface TemplateVariant {
  id: string;
  language: LanguageId | 'fr' | 'ar_msa' | 'ar_dz';
  body: string;
  /** Variant-level prior for the Beta bandit (successes/failures pseudo-counts). */
  priorSuccesses: number;
  priorFailures: number;
  notes?: string;
}

export interface MessageTemplate {
  id: string;
  /** Lifecycle stage the template belongs to. */
  stage: 'first_contact' | 'followup' | 'reply' | 'post_signup' | 'recovery';
  /** Human label for the operator console. */
  label: string;
  description: string;
  slots: string[];
  channels: ChannelId[];
  variants: TemplateVariant[];
  /** Guard: template only applies when one of these platforms matches. */
  platforms?: PlatformId[];
  minMaturity?: number;
  requiresLink?: boolean;
}

export const URL_SLOT = 'link';

export const TEMPLATES: readonly MessageTemplate[] = [
  {
    id: 'first_contact.advertiser',
    stage: 'first_contact',
    label: 'Ads merchant — first touch',
    description: 'For merchants running paid ads (Meta/TikTok pixel or Ad Library evidence).',
    slots: ['name', 'product'],
    channels: ['whatsapp', 'messenger', 'instagram', 'facebook'],
    variants: [
      {
        id: 'first_contact.advertiser.dz',
        language: 'ar_dz',
        priorSuccesses: 2,
        priorFailures: 3,
        body: 'السلام عليكم {name}، شفت الإعلان تاع {product} وخدمتك بينة 👌\nدرت أداة تأكد الطلب على واتساب قبل ما تشحن وتبيّنلك الطلبات اللي فيها خطر، باش تنقص الـ retour.\nتحب تجرب بالمجان؟',
      },
      {
        id: 'first_contact.advertiser.msa',
        language: 'ar_msa',
        priorSuccesses: 1,
        priorFailures: 3,
        body: 'السلام عليكم {name}، لاحظت إعلان {product} لديكم 👌\nأنا مطوّر جزائري، بنيت أداة تُأكِّد الطلبات على واتساب قبل الشحن وتُبيّن الطلبات عالية خطر الإرجاع.\nهل تجربونها مجانًا؟',
      },
      {
        id: 'first_contact.advertiser.fr',
        language: 'fr',
        priorSuccesses: 1,
        priorFailures: 4,
        body: "Bonjour {name}, j'ai vu votre pub pour {product} 👌\nJ'ai construit un outil qui confirme les commandes sur WhatsApp avant expédition et signale les commandes à risque de retour.\nVous voulez tester gratuitement ?",
      },
    ],
  },
  {
    id: 'first_contact.messaging_only',
    stage: 'first_contact',
    label: 'Inbox seller (Messenger/IG) — first touch',
    description: 'For merchants selling from DMs, without a real storefront.',
    slots: ['name', 'product'],
    channels: ['messenger', 'instagram', 'facebook'],
    variants: [
      {
        id: 'first_contact.messaging_only.dz',
        language: 'ar_dz',
        priorSuccesses: 2,
        priorFailures: 3,
        body: 'السلام عليكم {name}، تابعت صفحتك و{product} تاعك تحفة.\nنلاحظ بلي الطلبات تجيك في الرسائل، وهذا ياكل وقت في تسجيل كل طلب بالإيد.\nدرت منصة تخلي الطلبات توصلك مرتبة (الاسم، الولاية، الهاتف) وتصدرها لشركة الشحن بضغطة. تحب تجربها بالمجان؟',
      },
      {
        id: 'first_contact.messaging_only.msa',
        language: 'ar_msa',
        priorSuccesses: 1,
        priorFailures: 3,
        body: 'السلام عليكم {name}، صفحتكم و{product} جميلان.\nألاحظ أن الطلبات تصلكم في الرسائل، وهذا يستهلك وقتًا كبيرًا في التسجيل اليدوي.\nبنيت منصة تُرتِّب الطلبات (الاسم، الولاية، الهاتف) وتُصدّرها لشركة الشحن بضغطة واحدة. هل تجربونها مجانًا؟',
      },
      {
        id: 'first_contact.messaging_only.fr',
        language: 'fr',
        priorSuccesses: 1,
        priorFailures: 4,
        body: "Bonjour {name}, j'ai suivi votre page, {product} est top.\nJe vois que les commandes arrivent en DM : c'est beaucoup de saisie manuelle.\nJ'ai fait une plateforme qui vous livre les commandes structurées (nom, wilaya, téléphone) et les exporte au transporteur en un clic. Test gratuit ?",
      },
    ],
  },
  {
    id: 'first_contact.other_platform',
    stage: 'first_contact',
    label: 'Existing storefront (other platform) — first touch',
    description: 'For merchants already on Shopify/YouCan/WooCommerce/LightFunnels.',
    slots: ['name', 'platform'],
    channels: ['whatsapp', 'messenger', 'instagram', 'facebook', 'email'],
    platforms: ['shopify', 'youcan', 'woocommerce', 'wordpress', 'prestashop', 'lightfunnels', 'wix', 'squarespace', 'webflow', 'magento', 'salla', 'zid', 'custom'],
    requiresLink: false,
    variants: [
      {
        id: 'first_contact.other_platform.dz',
        language: 'ar_dz',
        priorSuccesses: 2,
        priorFailures: 3,
        body: 'السلام عليكم {name}، شفت المتجر تاعك على {platform}، مرتب ماشاء الله.\nفضول: تأكد الطلبات بالتيليفون بالإيد؟\nدرت منصة جزائرية للـ paiement à la livraison فيها تأكيد على واتساب. ما نطلبش منك تخلي منصتك، غير تجرب متجر موازي بمنتج واحد. بالمجان.',
      },
      {
        id: 'first_contact.other_platform.fr',
        language: 'fr',
        priorSuccesses: 1,
        priorFailures: 3,
        body: "Bonjour {name}, j'ai vu votre boutique sur {platform}, très propre.\nSimple curiosité : vous confirmez les commandes au téléphone à la main ?\nJ'ai fait une plateforme algérienne de paiement à la livraison avec confirmation WhatsApp. Je ne vous demande pas de quitter votre plateforme, juste de tester une boutique parallèle avec un seul produit. Gratuit.",
      },
      {
        id: 'first_contact.other_platform.msa',
        language: 'ar_msa',
        priorSuccesses: 1,
        priorFailures: 4,
        body: 'السلام عليكم {name}، اطّلعت على متجركم على {platform}، منظّم ما شاء الله.\nسؤال: هل تؤكِّدون الطلبات هاتفيًا يدويًا؟\nبنيت منصة جزائرية للدفع عند الاستلام فيها تأكيد عبر واتساب. لا نطلب منكم التخلي عن منصتكم، فقط تجربة متجر موازٍ بمنتج واحد. مجانًا.',
      },
    ],
  },
  {
    id: 'first_contact.new_small',
    stage: 'first_contact',
    label: 'New/small merchant — first touch',
    description: 'For young or very small stores (low maturity, few products).',
    slots: ['name'],
    channels: ['whatsapp', 'messenger', 'instagram', 'facebook'],
    variants: [
      {
        id: 'first_contact.new_small.dz',
        language: 'ar_dz',
        priorSuccesses: 2,
        priorFailures: 4,
        body: 'السلام عليكم {name}، ربي يبارك في مشروعك 🤲\nأنا مطور جزائري ودرت منصة تسهّل على التاجر الجديد يطلق متجره بلا خبرة تقنية.\nنحوس على 5 تجار غير يجربوها ونعاونهم في الإعداد بنفسي مقابل رأيهم الصريح. تحب تكون واحد منهم؟',
      },
      {
        id: 'first_contact.new_small.fr',
        language: 'fr',
        priorSuccesses: 1,
        priorFailures: 4,
        body: 'Bonjour {name}, bravo pour votre projet 🤲\nJe suis développeur algérien : j\'ai fait une plateforme qui permet de lancer sa boutique sans compétence technique.\nJe cherche 5 marchands pour la tester et je les accompagne moi-même dans la configuration, en échange d\'un avis honnête. Ça vous dit ?',
      },
    ],
  },
  {
    id: 'followup.once',
    stage: 'followup',
    label: 'Single follow-up',
    description: 'Sent at most once, at least 3 days after the first message.',
    slots: [],
    channels: ['whatsapp', 'messenger', 'instagram', 'facebook', 'email'],
    variants: [
      {
        id: 'followup.once.dz',
        language: 'ar_dz',
        priorSuccesses: 1,
        priorFailures: 6,
        body: 'السلام عليكم، نعاود الرسالة في حالة فاتتك. ما كاين حتى مشكل إذا ما تناسبكش، وبارك الله فيك على وقتك.',
      },
      {
        id: 'followup.once.fr',
        language: 'fr',
        priorSuccesses: 1,
        priorFailures: 6,
        body: "Bonjour, je reviens vers vous au cas où mon message serait passé inaperçu. Aucun souci si ça ne vous intéresse pas, merci pour votre temps.",
      },
    ],
  },
  {
    id: 'reply.interested_link',
    stage: 'reply',
    label: 'Interested → signup link',
    description: 'Only after the merchant shows interest (link slot).',
    slots: ['link'],
    channels: ['whatsapp', 'messenger', 'instagram', 'facebook', 'email'],
    requiresLink: true,
    variants: [
      {
        id: 'reply.interested_link.dz',
        language: 'ar_dz',
        priorSuccesses: 3,
        priorFailures: 1,
        body: 'الله يبارك 👌 التسجيل بحساب قوقل في دقيقة: {link} — وأنا معاك خطوة بخطوة إذا احتجت أي مساعدة.',
      },
      {
        id: 'reply.interested_link.fr',
        language: 'fr',
        priorSuccesses: 2,
        priorFailures: 1,
        body: "Parfait 👌 L'inscription avec un compte Google prend une minute : {link} — je vous accompagne pas à pas si besoin.",
      },
    ],
  },
  {
    id: 'post_signup.pro_gift',
    stage: 'post_signup',
    label: 'Post-signup PRO gift',
    description: 'Sent after the merchant signs up (human-triggered).',
    slots: [],
    channels: ['whatsapp', 'messenger', 'instagram', 'facebook', 'email'],
    variants: [
      {
        id: 'post_signup.pro_gift.dz',
        language: 'ar_dz',
        priorSuccesses: 3,
        priorFailures: 1,
        body: 'شفت سجلت 👌 فعّلتلك خطة PRO مجاناً لشهر باش تجرب التأكيد الأوتوماتيك على واتساب. بعد أسبوعين نحب نعرف رأيك بصراحة.',
      },
      {
        id: 'post_signup.pro_gift.fr',
        language: 'fr',
        priorSuccesses: 2,
        priorFailures: 1,
        body: "J'ai vu votre inscription 👌 Je vous ai activé le plan PRO gratuitement pendant un mois pour tester la confirmation automatique sur WhatsApp. Dans deux semaines j'aimerais votre avis honnête.",
      },
    ],
  },
];

export function templateById(id: string): MessageTemplate | null {
  return TEMPLATES.find((template) => template.id === id) ?? null;
}

export function templateVariantById(variantId: string): { template: MessageTemplate; variant: TemplateVariant } | null {
  for (const template of TEMPLATES) {
    const variant = template.variants.find((candidate) => candidate.id === variantId);
    if (variant) return { template, variant };
  }
  return null;
}

export function variantsForLanguage(
  template: MessageTemplate,
  language: LanguageId,
): TemplateVariant[] {
  const exact = template.variants.filter((variant) => variant.language === language);
  if (exact.length > 0) return exact;
  if (language === 'mixed') {
    // A mixed-script merchant gets either the Darija or the French variant, and
    // the Thompson bandit learns which one converts better.
    const dz = template.variants.filter((variant) => variant.language === 'ar_dz');
    const fr = template.variants.filter((variant) => variant.language === 'fr');
    const combined = [...dz, ...fr];
    if (combined.length > 0) return combined;
  }
  return template.variants;
}
