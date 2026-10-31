/**
 * Web search layer — finds investor pages and PUBLIC LinkedIn profiles.
 *
 * We never log in to LinkedIn or scrape it (that breaks LinkedIn's terms and
 * gets accounts banned). Instead we ask a search engine for public profile
 * pages, e.g.  site:linkedin.com/in "angel investor" "family tech"  — the same
 * thing you could type into Google yourself.
 *
 * Providers (all have free plans with no credit card), used in this order:
 *   TAVILY_API_KEY   tavily.com   — 1,000 free credits / month
 *   SERPER_API_KEY   serper.dev   — 2,500 free Google searches (one-time)
 *   (no key)         DuckDuckGo HTML — free fallback, can be rate limited
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine: string;
}

const env = (k: string) => (process.env[k] || '').trim();
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export function searchProviderNames(): string[] {
  const out: string[] = [];
  if (env('TAVILY_API_KEY')) out.push('tavily');
  if (env('SERPER_API_KEY')) out.push('serper');
  if (env('DISABLE_DUCKDUCKGO') !== 'true') out.push('duckduckgo');
  return out;
}

const disabledUntil: Record<string, number> = {};

function decodeEntities(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split `site:linkedin.com/in foo bar` into include-domain + plain query (for Tavily). */
function splitSiteOperator(q: string): { query: string; domain?: string } {
  const m = q.match(/site:(\S+)/i);
  if (!m) return { query: q };
  return { query: q.replace(m[0], '').trim(), domain: m[1] };
}

async function tavily(query: string, max: number, page = 1): Promise<SearchResult[]> {
  if (page > 1) return []; // Tavily has no paging
  const { query: q, domain } = splitSiteOperator(query);
  const body: any = { query: domain ? `${q} ${domain.includes('linkedin') ? 'LinkedIn' : ''}`.trim() : q, max_results: Math.min(max, 20), search_depth: 'basic' };
  if (domain) body.include_domains = [domain.replace(/\/.*$/, '')];
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env('TAVILY_API_KEY')}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000)
  });
  if (!res.ok) throw new Error(`tavily ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const data: any = await res.json();
  let results: SearchResult[] = (data?.results || []).map((r: any) => ({
    title: String(r.title || ''),
    url: String(r.url || ''),
    snippet: String(r.content || '').slice(0, 600),
    engine: 'tavily'
  }));
  if (domain && domain.includes('/')) {
    const path = domain.slice(domain.indexOf('/'));
    results = results.filter(r => r.url.includes(path));
  }
  return results;
}

async function serper(query: string, max: number, page = 1): Promise<SearchResult[]> {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': env('SERPER_API_KEY') },
    body: JSON.stringify(page > 1 ? { q: query, num: Math.min(max, 20), page } : { q: query, num: Math.min(max, 20) }),
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`serper ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const data: any = await res.json();
  return (data?.organic || []).map((r: any) => ({
    title: String(r.title || ''),
    url: String(r.link || ''),
    snippet: String(r.snippet || ''),
    engine: 'serper'
  }));
}

export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const blocks = html.split(/class="result results_links|class="result results_links_deep|class="result /).slice(1);
  for (const b of blocks) {
    const a = b.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let href = a[1].replace(/&amp;/g, '&');
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1]);
    if (href.startsWith('//')) href = 'https:' + href;
    if (!/^https?:\/\//.test(href) || /duckduckgo\.com\/y\.js/.test(href)) continue;
    const sn = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    out.push({ title: decodeEntities(a[2]), url: href, snippet: sn ? decodeEntities(sn[1]) : '', engine: 'duckduckgo' });
  }
  return out;
}

async function duckduckgo(query: string, max: number, page = 1): Promise<SearchResult[]> {
  if (page > 1) return []; // keep DuckDuckGo to page 1 (it blocks fast)
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Accept: 'text/html' },
    body: new URLSearchParams({ q: query, kl: 'us-en' }).toString(),
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`duckduckgo ${res.status}`);
  const html = await res.text();
  if (/anomaly-modal|captcha|challenge/i.test(html) && !/result__a/.test(html)) throw new Error('duckduckgo rate-limited (captcha)');
  return parseDuckDuckGoHtml(html).slice(0, max);
}

const engines: Record<string, (q: string, n: number, page?: number) => Promise<SearchResult[]>> = { tavily, serper, duckduckgo };

/** Run one query through the first provider that works. */
export async function webSearch(query: string, max = 10, page = 1): Promise<{ results: SearchResult[]; engine: string; errors: string[] }> {
  const errors: string[] = [];
  for (const name of searchProviderNames()) {
    if ((disabledUntil[name] || 0) > Date.now()) continue;
    try {
      const results = (await engines[name](query, max, page)).filter(r => r.url);
      if (results.length) return { results, engine: name, errors };
      errors.push(`${name}: 0 results`);
    } catch (e: any) {
      const msg = String(e?.message || e);
      errors.push(`${name}: ${msg}`);
      // out of credits / bad key → park this provider for an hour; captcha → 10 minutes
      if (/\b(401|402|403|432|433)\b|credits|quota|limit/i.test(msg)) disabledUntil[name] = Date.now() + 3600_000;
      else if (/captcha|rate/i.test(msg)) disabledUntil[name] = Date.now() + 600_000;
    }
  }
  return { results: [], engine: 'none', errors };
}

export function normalizeLinkedInUrl(url: string): string {
  const m = url.match(/linkedin\.com\/(in|company|pub)\/([^/?#]+)/i);
  if (!m) return '';
  return `https://www.linkedin.com/${m[1].toLowerCase()}/${decodeURIComponent(m[2])}`;
}

export function isLinkedInProfile(url: string): boolean {
  return /linkedin\.com\/(in|pub)\//i.test(url);
}
