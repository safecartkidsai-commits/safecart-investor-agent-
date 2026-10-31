/**
 * Website reader (replaces the fake "Firecrawl" simulation).
 * Fetches a public page and turns it into clean text the AI can read.
 * Falls back to the free Jina Reader (r.jina.ai, no key needed) for
 * JavaScript-heavy sites. LinkedIn pages are never fetched.
 */

export interface PageContent {
  url: string;
  title: string;
  description: string;
  text: string;
  emails: string[];
  /** US-format phone numbers published on the page, e.g. "(480) 555-0123" */
  phones?: string[];
  links: { href: string; text: string }[];
  via: 'direct' | 'jina' | 'failed';
  error?: string;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const BLOCKED_HOSTS = /(^|\.)linkedin\.com$|(^|\.)facebook\.com$|(^|\.)instagram\.com$|(^|\.)x\.com$|(^|\.)twitter\.com$/i;

export function canFetch(url: string): boolean {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    if (BLOCKED_HOSTS.test(u.hostname)) return false;
    // never let the server be pointed at private network addresses
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$)/i.test(u.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

function decode(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const JUNK_EMAIL = /(\.png|\.jpg|\.jpeg|\.gif|\.webp|\.svg|example\.com|sentry|wixpress|domain\.com|email\.com|yourname|@2x)/i;

/** Cloudflare hides emails as hex ("data-cfemail" / "/cdn-cgi/l/email-protection#…"). Decode them. */
export function decodeCloudflareEmails(html: string): string[] {
  const out: string[] = [];
  const hexes = [
    ...[...html.matchAll(/data-cfemail=["']([0-9a-f]{4,})["']/gi)].map(m => m[1]),
    ...[...html.matchAll(/email-protection#([0-9a-f]{4,})/gi)].map(m => m[1])
  ];
  for (const hex of hexes) {
    try {
      const key = parseInt(hex.slice(0, 2), 16);
      let e = '';
      for (let i = 2; i < hex.length; i += 2) e += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
      if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e)) out.push(e);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** "jane [at] fund [dot] com", "jane(at)fund.com", "jane at fund dot com" → jane@fund.com */
function unObfuscate(text: string): string {
  return text
    .replace(/\s*[\[(<{]\s*at\s*[\])>}]\s*/gi, '@')
    .replace(/\s*[\[(<{]\s*dot\s*[\])>}]\s*/gi, '.')
    .replace(/\b([a-z0-9._%+-]+)\s+at\s+([a-z0-9-]+)\s+dot\s+([a-z]{2,})\b/gi, '$1@$2.$3');
}

/** US phone numbers in text / tel: links → "(480) 555-0123". Skips things that look like dates or ids. */
export function extractPhones(text: string): string[] {
  const out: string[] = [];
  const re = /(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?([2-9]\d{2})[\s.-]?(\d{4})(?!\d)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.length < 10) {
    const before = text[m.index - 1] || ' ';
    if (/[\d\/A-Za-z]/.test(before)) continue; // part of a longer number, id or url
    const raw = m[0];
    // must look like a phone: separators, parentheses or a tel: link — not a bare 10-digit id
    if (!/[\s.()+-]/.test(raw) && !/tel:[^\d]*$/i.test(text.slice(Math.max(0, m.index - 6), m.index))) continue;
    if (m[2] === '555' && /^01\d\d$/.test(m[3])) continue; // fictional 555-01xx numbers
    out.push(`(${m[1]}) ${m[2]}-${m[3]}`);
  }
  return [...new Set(out)];
}

export function extractEmails(text: string): string[] {
  const found = (unObfuscate(text).match(EMAIL_RE) || []).map(e => e.toLowerCase().replace(/\.$/, ''));
  return [...new Set(found.filter(e => !JUNK_EMAIL.test(e)))].slice(0, 10);
}

export function htmlToContent(html: string, url: string): Omit<PageContent, 'via'> {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim());
  const description = decode(
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] ||
      html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i)?.[1] ||
      ''
  );

  const links: { href: string; text: string }[] = [];
  const linkRe = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) && links.length < 300) {
    try {
      const href = new URL(decode(m[1]), url).toString();
      const text = decode(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      links.push({ href, text: text.slice(0, 80) });
    } catch {
      /* ignore bad hrefs */
    }
  }

  const mailtos = [...html.matchAll(/mailto:([^"'?\s>]+)/gi)].map(x => decodeURIComponent(x[1]));

  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<h(\d)[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ');
  body = decode(body)
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();

  const hidden = decodeCloudflareEmails(html);
  const tels = [...html.matchAll(/href=["']tel:([^"']+)["']/gi)].map(x => 'tel:' + decodeURIComponent(x[1]));
  return { url, title, description, text: body, emails: extractEmails([...mailtos, ...hidden].join(' ') + ' ' + body), phones: extractPhones(tels.join(' ') + ' ' + body), links };
}

async function viaJina(url: string): Promise<PageContent> {
  const res = await fetch(`https://r.jina.ai/${url}`, {
    headers: { Accept: 'text/plain', 'X-Return-Format': 'markdown' },
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error(`jina ${res.status}`);
  const md = await res.text();
  const title = md.match(/^Title:\s*(.+)$/m)?.[1]?.trim() || '';
  const links = [...md.matchAll(/\[([^\]]{1,80})\]\((https?:\/\/[^)\s]+)\)/g)].slice(0, 300).map(x => ({ text: x[1], href: x[2] }));
  return { url, title, description: '', text: md, emails: extractEmails(md), phones: extractPhones(md), links, via: 'jina' };
}

/** Fetch a page; never throws. */
export async function readPage(url: string, maxChars = 12000): Promise<PageContent> {
  if (!canFetch(url)) return { url, title: '', description: '', text: '', emails: [], links: [], via: 'failed', error: 'not fetchable' };
  let direct: PageContent | null = null;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000)
    });
    const type = res.headers.get('content-type') || '';
    if (res.ok && /html|text/i.test(type)) {
      const html = (await res.text()).slice(0, 1_500_000);
      direct = { ...htmlToContent(html, res.url || url), via: 'direct' };
    }
  } catch {
    /* try jina */
  }
  if (!direct || direct.text.length < 400) {
    try {
      const j = await viaJina(url);
      if (j.text.length > (direct?.text.length || 0)) direct = j;
    } catch (e: any) {
      if (!direct) return { url, title: '', description: '', text: '', emails: [], links: [], via: 'failed', error: e?.message };
    }
  }
  direct!.text = direct!.text.slice(0, maxChars);
  return direct!;
}

/**
 * Pick the most useful sub-pages on the same site — one of each kind, in this order:
 * contact (where emails live), team/people, portfolio, thesis.
 */
export function pickUsefulSubpages(page: PageContent, max = 3): string[] {
  let host = '';
  try {
    host = new URL(page.url).hostname.replace(/^www\./, '');
  } catch {
    return [];
  }
  const kinds: [string, RegExp][] = [
    ['contact', /contact|get-in-touch|reach-us|pitch|submit|apply/],
    ['team', /team|people|partners|about|who-we-are/],
    ['portfolio', /portfolio|companies|investments/],
    ['thesis', /thesis|focus|approach|what-we-invest|philosophy/]
  ];
  const own = page.links.filter(l => {
    try {
      return new URL(l.href).hostname.replace(/^www\./, '') === host;
    } catch {
      return false;
    }
  });
  const seen = new Set<string>([page.url.replace(/\/$/, '')]);
  const out: string[] = [];
  for (const [, re] of kinds) {
    if (out.length >= max) break;
    const hit = own.find(l => {
      const href = l.href.split('#')[0].replace(/\/$/, '');
      return re.test(`${href} ${l.text}`.toLowerCase()) && !seen.has(href);
    });
    if (hit) {
      const href = hit.href.split('#')[0].replace(/\/$/, '');
      seen.add(href);
      out.push(href);
    }
  }
  return out;
}
