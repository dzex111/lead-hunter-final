import { normalizeAlgerianPhone } from '@/core/normalize/phone';
import { safeCanonicalizeUrl } from '@/core/normalize/url';

export type SocialNetwork = 'facebook' | 'instagram' | 'tiktok' | 'whatsapp' | 'messenger';

export interface NormalizedHandle {
  network: SocialNetwork;
  /** Lowercased handle, numeric page id, or E.164 for WhatsApp. */
  value: string;
  /** Canonical identity key, e.g. "facebook:page_id:123456". */
  key: string;
  profileUrl: string;
  /** True when the value came from a profile.php?id= style form. */
  viaId: boolean;
}

const NETWORK_HOSTS: Record<string, SocialNetwork> = {
  'facebook.com': 'facebook',
  'fb.com': 'facebook',
  'fb.me': 'facebook',
  'm.facebook.com': 'facebook',
  'web.facebook.com': 'facebook',
  'instagram.com': 'instagram',
  'instagr.am': 'instagram',
  'tiktok.com': 'tiktok',
  'vm.tiktok.com': 'tiktok',
  'wa.me': 'whatsapp',
  'api.whatsapp.com': 'whatsapp',
  'chat.whatsapp.com': 'whatsapp',
  'whatsapp.com': 'whatsapp',
  'm.me': 'messenger',
  'messenger.com': 'messenger',
};

const RESERVED_PATHS = new Set([
  'p', 'reel', 'reels', 'explore', 'stories', 'tv', 'about', 'help', 'privacy',
  'login', 'sharer', 'share', 'watch', 'marketplace', 'groups', 'photo', 'posts',
  'search', 'legal', 'policies', 'directory', 'hashtag',
]);

export function normalizeHandle(input: string, network?: SocialNetwork): NormalizedHandle | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (/^@?[\w.]{2,40}$/.test(trimmed) && network) {
    const value = trimmed.replace(/^@/, '').toLowerCase();
    return build(network, value, false);
  }

  const url = safeCanonicalizeUrl(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
  if (!url) return null;

  const hostKey = Object.keys(NETWORK_HOSTS).find((host) => url.host === host || url.host.endsWith(`.${host === 'facebook.com' ? 'facebook.com' : host}`));
  const resolvedNetwork = network ?? (hostKey ? NETWORK_HOSTS[hostKey] : undefined);
  if (!resolvedNetwork) return null;

  if (resolvedNetwork === 'whatsapp') {
    if (url.host === 'chat.whatsapp.com') return null; // group invite: not a merchant channel
    // api.whatsapp.com/send carries the number in the `phone` query parameter,
    // wa.me/<digits> carries it in the last path segment.
    let phoneRaw = '';
    try {
      phoneRaw = new URL(url.canonical).searchParams.get('phone') ?? '';
    } catch {
      phoneRaw = '';
    }
    if (phoneRaw.length === 0) phoneRaw = url.pathSegments[url.pathSegments.length - 1] ?? '';
    const phone = normalizeAlgerianPhone(phoneRaw, { requireMobile: true });
    if (!phone) return null;
    return {
      network: 'whatsapp',
      value: phone.e164,
      key: `whatsapp:${phone.e164}`,
      profileUrl: `https://wa.me/${phone.waDigits}`,
      viaId: false,
    };
  }

  if (resolvedNetwork === 'messenger') {
    const username = url.pathSegments[0];
    if (!username || RESERVED_PATHS.has(username)) {
      const numeric = trimmed.match(/(\d{8,})/);
      if (!numeric?.[1]) return null;
      return build('messenger', numeric[1], true);
    }
    return build('messenger', username.toLowerCase(), false);
  }

  if (resolvedNetwork === 'facebook') {
    const first = url.pathSegments[0] ?? '';
    if (first === 'profile.php') {
      const id = new URLSearchParams(url.canonical.split('?')[1] ?? '').get('id');
      if (!id || !/^\d{5,}$/.test(id)) return null;
      return build('facebook', id, true);
    }
    if (first === 'pages' || first === 'p') {
      const name = url.pathSegments[1];
      if (!name) return null;
      return build('facebook', name.toLowerCase(), false);
    }
    if (!first || RESERVED_PATHS.has(first)) return null;
    return build('facebook', first.toLowerCase(), false);
  }

  const handle = (url.pathSegments[0] ?? '').replace(/^@/, '').toLowerCase();
  if (!handle || RESERVED_PATHS.has(handle)) return null;
  return build(resolvedNetwork, handle, false);
}

function build(network: SocialNetwork, value: string, viaId: boolean): NormalizedHandle {
  const key = network === 'facebook' && viaId ? `facebook:page_id:${value}` : `${network}:${value}`;
  const profileUrl =
    network === 'facebook'
      ? viaId
        ? `https://www.facebook.com/profile.php?id=${value}`
        : `https://www.facebook.com/${value}`
      : network === 'instagram'
        ? `https://www.instagram.com/${value}`
        : network === 'messenger'
          ? `https://m.me/${value}`
          : network === 'tiktok'
            ? `https://www.tiktok.com/@${value}`
            : `https://wa.me/${value.replace('+', '')}`;
  return { network, value, key, profileUrl, viaId };
}

const HANDLE_PATTERNS: { network: SocialNetwork; pattern: RegExp }[] = [
  // The scheme is optional: operators paste bare "wa.me/213..." strings all the time.
  { network: 'whatsapp', pattern: /(?:https?:\/\/)?(?:api\.)?wa\.me\/[^\s"'<>)]+/gi },
  { network: 'whatsapp', pattern: /(?:https?:\/\/)?api\.whatsapp\.com\/send\?[^\s"'<>)]+/gi },
  { network: 'messenger', pattern: /(?:https?:\/\/)?(?:www\.)?m\.me\/[^\s"'<>)]+/gi },
  { network: 'facebook', pattern: /https?:\/\/(?:www\.|web\.|m\.)?facebook\.com\/[^\s"'<>)]+/gi },
  { network: 'instagram', pattern: /https?:\/\/(?:www\.)?instagram\.com\/[^\s"'<>)]+/gi },
  { network: 'tiktok', pattern: /https?:\/\/(?:www\.)?tiktok\.com\/[^\s"'<>)]+/gi },
];

export function extractHandles(text: string): NormalizedHandle[] {
  const out: NormalizedHandle[] = [];
  const seen = new Set<string>();
  for (const { network, pattern } of HANDLE_PATTERNS) {
    const matches = text.match(pattern) ?? [];
    for (const match of matches) {
      const parsed = normalizeHandle(match, network);
      if (!parsed) continue;
      if (seen.has(parsed.key)) continue;
      seen.add(parsed.key);
      out.push(parsed);
    }
  }
  return out;
}

export function extractEmails(text: string): string[] {
  const matches = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [];
  const filtered = matches
    .map((value) => value.toLowerCase())
    .filter((value) => !value.endsWith('example.com') && !value.includes('sentry') && !value.startsWith('noreply@'));
  return Array.from(new Set(filtered));
}
