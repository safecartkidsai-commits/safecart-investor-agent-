/**
 * The investor agent.
 *
 *   Phase 1  analyzeProduct      → understand the app (reads its website)
 *   Phase 2  discoverCandidates  → web + public-LinkedIn search, AI extracts real investors
 *   Phase 3  researchCandidate   → reads the investor's site, finds LinkedIn, portfolio, contact route
 *   Phase 4  (inside research)   → AI fit score 0-100 for THIS app
 *   Phase 5  (inside research)   → personalised 4-step email cadence + LinkedIn note/DM
 *   runAgentJob                  → does all of it in one click, with a live log
 */
import { chatJson } from './ai';
import { Audience, audienceOf, expertQueries, EXPERT_TYPES, isNotFundraisingExpert, looksLikeFundraiser } from '../src/data/audience';
import { targetGeo, geoRule, withGeo, outsideTarget } from '../src/data/geo';
import { simplifyQuery } from '../src/data/queries';
import { TEMPLATE_V, buildEmails, buildLinkedIn } from '../src/data/emailTemplates';
import { webSearch, SearchResult, isLinkedInProfile, normalizeLinkedInUrl } from './search';
import { readPage, pickUsefulSubpages, canFetch, extractEmails, PageContent } from './reader';
import type {
  StartupProfile,
  AppSettings,
  Investor,
  InvestorFitScore,
  EmailSequenceStep,
  DiscoveryCandidate,
  AgentJob,
  PipelineExecutionLog,
  InvestorType,
  InvestmentStage
} from '../src/types';

// ---------------------------------------------------------------- helpers
const arr = (x: any, max = 20): string[] =>
  (Array.isArray(x) ? x : typeof x === 'string' && x ? [x] : [])
    .map((v: any) => (typeof v === 'string' ? v : v?.name || JSON.stringify(v)))
    .map((v: string) => v.trim())
    .filter(Boolean)
    .slice(0, max);
const str = (x: any, max = 2000): string => (typeof x === 'string' ? x.trim().slice(0, max) : x == null ? '' : String(x).slice(0, max));
const clamp = (n: any, lo = 0, hi = 100): number => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
};
const today = () => new Date().toISOString().slice(0, 10);
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const INVESTOR_TYPES: InvestorType[] = ['Angel', 'VC Fund', 'Micro-VC', 'Family Office', 'Angel Group', 'Accelerator', 'Corporate VC', 'Other', ...EXPERT_TYPES];
const isExp = (a?: Audience | string) => a === 'experts';
/** In the experts list, an investor-only type becomes "Other" (and vice versa stays as is). */
const expType = (t: InvestorType, exp: boolean): InvestorType =>
  exp && !(EXPERT_TYPES as readonly string[]).includes(t) && t !== 'Accelerator' ? 'Other' : t;
const typeList = (a?: Audience | string) =>
 isExp(a) ? 'Fundraising Consultant | Fundraising Advisor | Investment Banker | Other' : 'Angel | VC Fund | Micro-VC | Family Office | Angel Group | Accelerator | Corporate VC | Other';
const STAGES: InvestmentStage[] = ['Pre-seed', 'Seed', 'Series A', 'Growth', 'All Stages', 'Unknown'];
const asType = (t: any): InvestorType => INVESTOR_TYPES.find(x => x.toLowerCase() === String(t || '').toLowerCase()) || 'Other';
const asStage = (s: any): InvestmentStage => {
  const v = String(s || '').toLowerCase();
  if (/pre.?seed/.test(v)) return 'Pre-seed';
  if (/^seed|seed/.test(v)) return 'Seed';
  if (/series a/.test(v)) return 'Series A';
  if (/growth|series [b-z]|late/.test(v)) return 'Growth';
  if (/all|multi|any/.test(v)) return 'All Stages';
  return STAGES.find(x => x.toLowerCase() === v) || 'Unknown';
};

const NON_FIRM_HOSTS = [
  'linkedin.com', 'crunchbase.com', 'pitchbook.com', 'facebook.com', 'twitter.com', 'x.com', 'wikipedia.org', 'bloomberg.com',
  'medium.com', 'youtube.com', 'instagram.com', 'wellfound.com', 'angel.co', 'signal.nfx.com', 'tracxn.com', 'cbinsights.com',
  'dealroom.co', 'forbes.com', 'techcrunch.com', 'businessinsider.com', 'reddit.com', 'quora.com', 'github.com', 'zoominfo.com',
  'rocketreach.co', 'apollo.io', 'openvc.app', 'f6s.com', 'eu-startups.com', 'google.com', 'substack.com', 'prnewswire.com',
  'businesswire.com', 'globenewswire.com', 'yahoo.com', 'axios.com', 'inc.com', 'entrepreneur.com', 'fastcompany.com'
];
function isNonFirmUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return NON_FIRM_HOSTS.some(d => h === d || h.endsWith('.' + d));
  } catch {
    return true;
  }
}

export function startupBrief(s: StartupProfile): string {
  const lines = [
    `Name: ${s.name}`,
    s.website ? `Website: ${s.website}` : '',
    `One-liner: ${s.oneLiner}`,
    `Category: ${s.category}`,
    `Stage: ${s.stage}`,
    s.targetRaise ? `Raising: ${s.targetRaise}` : 'Raise amount: not specified (do NOT invent one)',
    s.checkSizeMin || s.checkSizeMax ? `Desired check size: ${s.checkSizeMin} - ${s.checkSizeMax}` : '',
    `Location: ${s.location}`,
    `Problem: ${s.problem}`,
    `Solution / edge: ${s.secretSauce}`,
    s.keyFeatures?.length ? `Key features: ${s.keyFeatures.join('; ')}` : '',
    s.tractionHighlights?.length ? `Facts / traction (ONLY these are true): ${s.tractionHighlights.join('; ')}` : 'Traction: none provided (do NOT invent any)',
    `Ideal investors: ${s.idealInvestorTraits}`,
    s.productDescription ? `AI product summary: ${s.productDescription}` : '',
    s.targetCustomers?.length ? `Buyers: ${s.targetCustomers.join('; ')}` : '',
    s.endUsers?.length ? `End users: ${s.endUsers.join('; ')}` : '',
    s.businessModel ? `Business model (analysis): ${s.businessModel}` : '',
    s.differentiation?.length ? `Differentiation: ${s.differentiation.join('; ')}` : '',
    s.competitors?.length ? `Comparable companies: ${s.competitors.join('; ')}` : '',
    s.investorKeywords?.length ? `Investor keywords: ${s.investorKeywords.join(', ')}` : '',
    s.extraContext ? `Extra context from founder: ${s.extraContext.slice(0, 2500)}` : ''
  ];
  return lines.filter(Boolean).join('\n');
}

/** People who want money from the founder BEFORE anything happens are filtered out. */
const NO_UPFRONT_RULE = `MONEY RULE: we do NOT work with anyone who asks the founder to pay before anything happens — retainers, monthly fees, application / pitch / membership / listing fees, "due diligence" fees, paid programs or paid investor-matching. Investors who invest, and experts paid only from results (success fee / commission on money actually raised), are fine.`;

const HONESTY_RULES = `Honesty rules (very important):
- Never invent traction, revenue, users, pilots, partnerships, quotes or metrics. Only use facts given to you.
- Never invent investors, people, emails, portfolio companies or URLs. If something is unknown, use "" or [].
- It is fine to give clearly-labelled analysis/opinion (e.g. likely business model), but not fake facts.`;

// ---------------------------------------------------------------- Phase 1
export async function analyzeProduct(s: StartupProfile, settings?: Partial<AppSettings>): Promise<Partial<StartupProfile>> {
  let siteText = '';
  if (s.website && canFetch(s.website)) {
    const home = await readPage(s.website, 8000);
    siteText = home.text ? `HOMEPAGE (${home.url}) title="${home.title}" desc="${home.description}"\n${home.text}` : '';
    for (const sub of pickUsefulSubpages(home, 2).filter(u => !/portfolio/.test(u))) {
      const p = await readPage(sub, 3000);
      if (p.text) siteText += `\n\nPAGE ${p.url}\n${p.text}`;
    }
  }
  const tg = targetGeo(s.location);
  const geo = `ONLY the ${tg.country}${tg.state ? ` (extra weight on ${tg.state})` : ''} — every query must aim at the ${tg.country}`;
  const local = settings?.includeLocalAngelGroups !== false;

  const out = await chatJson<any>(
    `You are a senior venture analyst preparing a startup for an investor search. Today is ${today()}.\n${HONESTY_RULES}`,
    `Analyse this product so an AI agent can find the RIGHT investors for it.

STARTUP PROFILE (from the founder):
${startupBrief(s)}

${siteText ? `WEBSITE TEXT (scraped just now):\n${siteText.slice(0, 9000)}` : 'Website could not be read; rely on the profile.'}

Geography focus for investors: ${geo}. ${local ? `Also include searches for local angel groups / investors near ${s.location}.` : ''}

Return JSON:
{
  "productDescription": "3-4 sentence plain-English description",
  "targetCustomers": ["who pays"],
  "endUsers": ["who uses it"],
  "businessModel": "most likely model(s), labelled as analysis if not stated",
  "marketDescription": "market + why now, 2-3 sentences, no made-up numbers",
  "competitors": ["real comparable companies / adjacent players investors know (e.g. kids fintech, kid-safe platforms)"],
  "differentiation": ["..."],
  "fundingUse": ["likely uses of a pre-seed/seed round"],
  "risksInvestorsWillAsk": ["tough questions investors will ask"],
  "investorKeywords": ["10-15 short theme keywords investors use, e.g. family tech, kids fintech, edtech, child safety"],
  "investorTypesToTarget": ["e.g. Angel", "Micro-VC", "Angel Group", "Family Office", "Corporate VC"],
  "linkedinSearchQueries": ["6 Google queries that find PUBLIC LinkedIn profiles of relevant investors. Each MUST start with site:linkedin.com/in and use quoted phrases, e.g. site:linkedin.com/in \\"angel investor\\" \\"family tech\\""],
  "webSearchQueries": ["8 web queries that find specific relevant funds/angels/angel groups and lists of investors in comparable startups, e.g. \\"pre-seed venture fund\\" kids fintech portfolio, investors in Greenlight BusyKid early stage"],
  "confidence": 0-100
}`,
    3500
  );

  return {
    productDescription: str(out.productDescription),
    targetCustomers: arr(out.targetCustomers),
    endUsers: arr(out.endUsers),
    businessModel: str(out.businessModel),
    marketDescription: str(out.marketDescription),
    competitors: arr(out.competitors, 15),
    differentiation: arr(out.differentiation),
    fundingUse: arr(out.fundingUse),
    risksInvestorsWillAsk: arr(out.risksInvestorsWillAsk),
    investorKeywords: arr(out.investorKeywords, 20),
    investorTypesToTarget: arr(out.investorTypesToTarget),
    linkedinSearchQueries: arr(out.linkedinSearchQueries, 10).map(q => (/site:linkedin\.com/i.test(q) ? q : `site:linkedin.com/in ${q}`)),
    webSearchQueries: arr(out.webSearchQueries, 12),
    aiConfidence: clamp(out.confidence),
    aiGeneratedAt: new Date().toISOString()
  };
}

export function defaultQueries(s: StartupProfile, settings?: Partial<AppSettings>): { linkedin: string[]; web: string[] } {
  const g = targetGeo(s.location);
  const q = rawDefaultQueries(s, settings);
  const tidy = (x: string) => withGeo(simplifyQuery(x), g);
  return { linkedin: [...new Set(q.linkedin.map(tidy))], web: [...new Set(q.web.map(tidy))] };
}

function rawDefaultQueries(s: StartupProfile, settings?: Partial<AppSettings>): { linkedin: string[]; web: string[] } {
  if (isExp(settings?.audience)) {
    const city = (s.location || '').split(',').slice(0, 2).map(x => x.trim()).join(' ').trim();
    return expertQueries((s.investorKeywords || []).slice(0, 5), settings?.includeLocalAngelGroups !== false ? city : '');
  }
  const kw = (s.investorKeywords?.length ? s.investorKeywords : ['family tech', 'kids fintech', 'edtech', 'parenting', 'child safety']).slice(0, 6);
  const linkedin = s.linkedinSearchQueries?.length
    ? s.linkedinSearchQueries
    : kw.slice(0, 5).map(k => `site:linkedin.com/in "angel investor" "${k}"`);
  const web = s.webSearchQueries?.length ? [...s.webSearchQueries] : kw.slice(0, 5).map(k => `pre-seed investors ${k} startups`);
  if (settings?.includeLocalAngelGroups !== false && s.location) {
    const city = s.location.split(',').slice(0, 2).join(' ');
    web.push(`angel investor groups ${city} early stage startups`);
  }
  // Investors who PUBLISH a pitch email (they want cold emails) — these are the ones we can auto-email.
  web.push(...emailFriendlyQueries(kw));
  return { linkedin, web };
}

/** Searches that surface funds / angel groups / accelerators that publish an email for pitches. */
export function emailFriendlyQueries(kw: string[]): string[] {
  const k = kw.length ? kw : ['consumer', 'family tech'];
  const pick = (i: number) => k[i % k.length];
  return [
    `"send us your pitch deck" pre-seed fund ${pick(0)}`,
    `"email your deck" seed investors ${pick(1)}`,
    `"pitch@" pre-seed venture fund consumer`,
    `"deals@" seed fund ${pick(2)} startups`,
    `"submit your deck" "email" angel investors ${pick(3)}`,
    `pre-seed fund "we read every email" founders ${pick(0)}`,
    `micro VC "email us" pitch deck consumer apps ${pick(1)}`,
    `angel network "apply" "email" early stage ${pick(2)}`
  ];
}

// ---------------------------------------------------------------- Phase 2
type Log = (phase: PipelineExecutionLog['phase'], message: string, level?: PipelineExecutionLog['level'], investorName?: string) => void;
const noLog: Log = () => {};

const looksLikeList = (r: SearchResult) =>
  !isLinkedInProfile(r.url) &&
  /(top \d+|\d+ (best|top)|list of|investors (in|for|who)|best .*investors|angel (groups|networks)|directory|vc firms|(best|top) .*(consultants|advisors|experts|coaches|cfos)|consultants (for|who))/i.test(`${r.title} ${r.snippet}`);

export async function runSearches(queries: string[], perQuery = 10, log: Log = noLog): Promise<SearchResult[]> {
  const seen = new Set<string>();
  const all: SearchResult[] = [];
  for (const q of queries) {
    const { results, engine, errors } = await webSearch(q, perQuery);
    if (!results.length) {
      log('search', `No results for: ${q}${errors.length ? ` (${errors.join('; ').slice(0, 160)})` : ''}`, 'warn');
      continue;
    }
    let added = 0;
    for (const r of results) {
      const key = r.url.replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(r);
      added++;
    }
    log('search', `${engine}: ${results.length} results (${added} new) — ${q}`, 'info');
  }
  return all;
}

export async function extractCandidates(
  s: StartupProfile,
  results: SearchResult[],
  existing: { name: string; firm: string }[],
  log: Log = noLog,
  maxListPages = 3,
  audience: Audience = 'investors'
): Promise<DiscoveryCandidate[]> {
  const exp = isExp(audience);
  const geo = targetGeo(s.location);
  // Read a few "list of investors" pages: they name many investors at once.
  const listPages: PageContent[] = [];
  for (const r of results.filter(looksLikeList).slice(0, maxListPages)) {
    const p = await readPage(r.url, 7000);
    if (p.text.length > 500 && !/just a moment|attention required|access denied|verify you are human/i.test(p.title)) {
      listPages.push(p);
      log('extract', `Read list page: ${p.title || r.title}`, 'info');
    }
  }

  const evidenceBlocks: { id: string; url: string; text: string }[] = [
    ...results.map((r, i) => ({ id: `R${i + 1}`, url: r.url, text: `${r.title}\n${r.snippet}` })),
    ...listPages.map((p, i) => ({ id: `L${i + 1}`, url: p.url, text: `${p.title}\n${p.text}` }))
  ];
  const validUrls = new Set(evidenceBlocks.map(b => b.url));
  const linkedinByBlock = new Map(results.map((r, i) => [`R${i + 1}`, isLinkedInProfile(r.url) ? normalizeLinkedInUrl(r.url) : '']));

  const out: DiscoveryCandidate[] = [];
  const seen = new Set(existing.map(e => normKey(e.name) + '|' + normKey(e.firm)));
  const seenNames = new Set(existing.map(e => normKey(e.name)));

  // Batch so prompts stay small enough for free-tier models.
  const batches: (typeof evidenceBlocks)[] = [];
  let cur: typeof evidenceBlocks = [];
  let size = 0;
  for (const b of evidenceBlocks) {
    const len = Math.min(b.text.length, 5000);
    if (size + len > 9000 && cur.length) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push({ ...b, text: b.text.slice(0, 5000) });
    size += len;
  }
  if (cur.length) batches.push(cur);

  for (const batch of batches) {
    let parsed: any;
    for (let tryNo = 0; tryNo < 2 && parsed === undefined; tryNo++) {
    if (tryNo > 0) {
      log('extract', 'AI busy — waiting, then retrying this batch of search results…', 'info');
      await new Promise(r => setTimeout(r, Number(process.env.AGENT_RETRY_WAIT_MS || 60000)));
    }
    try {
      parsed = await chatJson<any>(
        exp
          ? `You extract REAL, specific FUNDRAISING EXPERTS from search results — people or small firms who help startups raise money. ${HONESTY_RULES}
Only include someone if the evidence text itself names them AND shows their job is RAISING MONEY for startups: fundraising consultant / advisor, capital-raising advisor, someone who introduces startups to angel investors and VCs, or a boutique placement agent for early-stage raises.
NEVER include: lawyers, attorneys or law firms (even startup / venture lawyers), accountants / CPAs, pitch-deck designers, financial-model builders, marketing or web agencies, software tools, recruiters, journalists, investors who only invest, generic articles, and the startup itself.
${geoRule(geo)}
${NO_UPFRONT_RULE} Skip anyone whose evidence shows they charge founders upfront.`
          : `You extract REAL, specific investors from search results for a startup's fundraising. ${HONESTY_RULES}
Only include an investor if the evidence text itself names them AND indicates they invest (angel, VC, partner, fund, angel group, family office, accelerator).
Skip journalists, founders who are not investors, recruiters, generic articles, and the startup itself.
${geoRule(geo)}
${NO_UPFRONT_RULE} Skip anyone whose evidence shows they charge founders upfront (e.g. angel groups with application or pitch fees).`,
        `STARTUP:\n${startupBrief(s).slice(0, 1800)}

EVIDENCE (id | url | text):
${batch.map(b => `[${b.id}] ${b.url}\n${b.text}`).join('\n\n---\n\n')}

Return JSON: {"investors":[{
 "name": "person name, or the firm name if no person is named",
 "firm": ${exp ? '"their consultancy / company, or \\"Independent\\""' : '"fund / firm / angel group, or \\"Independent Angel\\""'},
 "title": ${exp ? '"e.g. Fundraising Consultant, Founder, Fractional CFO, Partner"' : '"e.g. Partner, Angel Investor, Managing Director"'},
 "investorType": "${typeList(audience)}",
 "location": "city, state / country if shown in the evidence, else \\"\\"",
 "country": "country they are based in if shown, else \\"\\"",
 "evidenceId": "the [id] where you saw them",
 "websiteUrl": "${exp ? 'their own website' : 'firm website'} ONLY if it appears in the evidence, else \\"\\"",
 "whyRelevant": "one sentence: ${exp ? 'how they could help' : 'why they may fit'} ${s.name}, based on the evidence"
}]}`,
        3500
      );
    } catch (e: any) {
      if (tryNo === 1) log('extract', `AI extraction failed for one batch: ${e?.message?.slice(0, 160)}`, 'warn');
    }
    }
    if (parsed === undefined) continue;
    for (const c of Array.isArray(parsed?.investors) ? parsed.investors : []) {
      const name = str(c.name, 120);
      if (!name || name.length < 3) continue;
      if (outsideTarget(`${str(c.country, 80)} ${str(c.location, 120)}`, geo)) continue; // not in the target country
      if (exp && isNotFundraisingExpert({ name, firm: str(c.firm, 120), title: str(c.title, 120) })) continue; // law firm, agency…
      const firm = str(c.firm, 120) || (exp ? 'Independent' : 'Independent Angel');
      const key = normKey(name) + '|' + normKey(firm);
      if (seen.has(key) || seenNames.has(normKey(name))) continue;
      const block = batch.find(b => b.id === str(c.evidenceId).replace(/[\[\]]/g, '')) || batch[0];
      let web = str(c.websiteUrl, 300);
      if (web && !(validUrls.has(web) || (/^https?:\/\//.test(web) && !isNonFirmUrl(web)))) web = '';
      const res = results.find(r => r.url === block.url);
      if (!web && res && !isLinkedInProfile(res.url) && !isNonFirmUrl(res.url) && !looksLikeList(res) && block.id.startsWith('R')) web = res.url;
      seen.add(key);
      seenNames.add(normKey(name));
      out.push({
        id: uid('cand'),
        name,
        firm,
        title: str(c.title, 120),
        investorType: expType(asType(c.investorType), exp),
        audience,
        linkedinUrl: linkedinByBlock.get(block.id) || '',
        websiteUrl: web,
        sourceUrl: block.url,
        sourceTitle: block.text.split('\n')[0].slice(0, 160),
        snippet: block.text.split('\n').slice(1).join(' ').slice(0, 400),
        whyRelevant: str(c.whyRelevant, 400),
        location: str(c.location, 120)
      });
    }
  }
  log('extract', `AI identified ${out.length} new ${exp ? 'fundraising experts' : 'investor candidates'}`, out.length ? 'success' : 'warn');
  return out;
}

export async function discoverCandidates(
  s: StartupProfile,
  queries: string[],
  existing: { name: string; firm: string }[],
  log: Log = noLog,
  audience: Audience = 'investors'
): Promise<{ candidates: DiscoveryCandidate[]; rawResults: SearchResult[] }> {
  const rawResults = await runSearches(queries, 10, log);
  if (!rawResults.length) return { candidates: [], rawResults };
  const candidates = await extractCandidates(s, rawResults, existing, log, 3, audience);
  return { candidates, rawResults };
}

// ---------------------------------------------------------------- Phase 3-5
export async function findLinkedInProfile(name: string, firm: string): Promise<string> {
  const q = `site:linkedin.com/in "${name}"${firm && !/independent/i.test(firm) ? ` ${firm}` : ''}`;
  const { results } = await webSearch(q, 6);
  const last = name.trim().split(/\s+/).pop()?.toLowerCase() || '';
  const hit = results.find(r => isLinkedInProfile(r.url) && (r.title.toLowerCase().includes(last) || r.url.toLowerCase().includes(last)));
  return hit ? normalizeLinkedInUrl(hit.url) : '';
}

async function findFirmWebsite(firm: string, name: string, exp = false): Promise<{ url: string; snippets: SearchResult[] }> {
  const q = exp
    ? /^independent$/i.test(firm) || !firm
      ? `"${name}" fundraising consultant startups`
      : `"${firm}" startup fundraising services`
    : /independent|angel$/i.test(firm)
      ? `"${name}" angel investor portfolio`
      : `"${firm}" venture investor portfolio`;
  const { results } = await webSearch(q, 8);
  const base = exp && (/^independent$/i.test(firm) || !firm) ? name : firm;
  const token = normKey(base.replace(/\b(the|capital|ventures?|partners|fund|vc|group|angels?|llc|inc|advisors?|consulting|consultants?)\b/gi, '')).slice(0, 6);
  const host = (u: string) => {
    try {
      return normKey(new URL(u).hostname);
    } catch {
      return '';
    }
  };
  const site = token.length >= 3 ? results.find(r => !isNonFirmUrl(r.url) && host(r.url).includes(token)) : undefined;
  return { url: site?.url || '', snippets: results };
}

function senderName(s: StartupProfile, settings?: Partial<AppSettings>) {
  return settings?.senderName || s.founderName || `${s.name} founding team`;
}

function fitStatus(total: number): 'hot' | 'warm' | 'cold' {
  return total >= 75 ? 'hot' : total >= 55 ? 'warm' : 'cold';
}

function normalizeFit(f: any): InvestorFitScore {
  const thesisMatch = clamp(f?.thesisMatch);
  const stageMatch = clamp(f?.stageMatch);
  const sectorMatch = clamp(f?.sectorMatch);
  const checkSizeMatch = clamp(f?.checkSizeMatch);
  const synergyMatch = clamp(f?.synergyMatch);
  const computed = Math.round(thesisMatch * 0.3 + stageMatch * 0.2 + sectorMatch * 0.25 + checkSizeMatch * 0.1 + synergyMatch * 0.15);
  const total = f?.total != null ? clamp(f.total) : computed;
  return {
    total,
    thesisMatch,
    stageMatch,
    sectorMatch,
    checkSizeMatch,
    synergyMatch,
    status: fitStatus(total),
    verdict: str(f?.verdict, 400),
    whyInvest: arr(f?.whyInvest, 5),
    hesitations: arr(f?.hesitations, 5),
    keyTalkingPoint: str(f?.keyTalkingPoint, 400)
  };
}

function siteRootOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').split('.').slice(-2).join('.');
  } catch {
    return '';
  }
}

/** Does this domain look like it belongs to the firm (or the person)? e.g. "brightkids.vc" ↔ "BrightKids Capital". */
export function siteMatchesFirm(root: string, firm: string, person: string): boolean {
  const label = (root.split('.')[0] || '').toLowerCase();
  if (label.length < 3) return false;
  const words = `${firm} ${person}`.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !/^(capital|ventures?|partners?|fund|group|angels?|investors?|independent|holdings|management|the)$/.test(w));
  const squashed = (firm || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return words.some(w => label.includes(w)) || (squashed.length >= 4 && squashed.includes(label));
}

/** Bump when the email finder improves, so older investors can be re-checked. */
export const EMAIL_SEARCH_V = 2;

const BAD_INBOX = /^(no-?reply|donotreply|privacy|legal|careers?|jobs|recruit|press|media|pr|unsubscribe|abuse|webmaster|billing|accounts?|admin|support|help|security|dpo|gdpr)[@.+-]/;
const GOOD_INBOX = /^(invest|investments|investors|pitch|pitches|deals?|dealflow|deal-flow|founders?|startups?|apply|partners?|team|hello|hi|info|contact|ventures?|office)[@.+-]/;

/** Best published email on the investor's own domain: their personal one first, then a deal-flow / general inbox. */
export function bestEmail(list: string[], personName: string, siteRoot: string): string {
  if (!siteRoot) return '';
  const own = list.filter(e => {
    const d = e.split('@')[1] || '';
    return (d === siteRoot || d.endsWith('.' + siteRoot)) && !BAD_INBOX.test(e);
  });
  if (!own.length) return '';
  const parts = personName.toLowerCase().split(/\s+/).map(x => x.replace(/[^a-z]/g, '')).filter(x => x.length > 1);
  const personal = own.find(e => {
    const local = e.split('@')[0].replace(/[^a-z]/g, '');
    return parts.some(p => local.includes(p)) || (parts.length > 1 && local === parts[0][0] + parts[parts.length - 1]);
  });
  if (personal) return personal;
  const ranked = own.filter(e => GOOD_INBOX.test(e));
  const order = (e: string) => {
    const k = e.split('@')[0];
    return /invest|pitch|deal|founder|startup|apply/.test(k) ? 0 : /partner|team|ventures/.test(k) ? 1 : 2;
  };
  return ranked.sort((a, b) => order(a) - order(b))[0] || '';
}

function normalizeSequence(seq: any): EmailSequenceStep[] {
  const delays = [0, 4, 10, 21];
  return (Array.isArray(seq) ? seq : []).slice(0, 4).map((x: any, i: number) => ({
    stepNumber: i + 1,
    dayDelay: Number.isFinite(Number(x?.dayDelay)) ? Number(x.dayDelay) : delays[i],
    stepName: str(x?.stepName, 80) || ['Intro', 'Follow-up', 'Value add', 'Close the loop'][i],
    subject: str(x?.subject, 160),
    body: str(x?.body, 3000),
    rationale: str(x?.rationale, 300)
  }));
}

/**
 * The emails themselves are fixed templates (src/data/emailTemplates.ts) — the AI only writes ONE sentence about the person.
 */
const OUTREACH_SPEC = (_s: StartupProfile, _settings?: Partial<AppSettings>, audience?: Audience) => `"personalLine": "ONE sentence (max 35 words) for the email, written as the founder to this person, about a SPECIFIC fact from the evidence — ${
  isExp(audience)
    ? 'e.g. a startup they helped raise, their investor network, or their fundraising focus. Example: \"I came across your work helping early-stage consumer startups raise their seed rounds, which is exactly the experience we are looking for.\"'
    : 'e.g. a portfolio company, their sector focus or something they said. Example: \"I noticed your investment in Greenlight, and I believe SafeCartKids shares the same mission of empowering families.\"'
}. Use ONLY facts from the evidence; if there is nothing specific, return \"\"."`;

export async function researchCandidate(
  s: StartupProfile,
  c: DiscoveryCandidate,
  settings?: Partial<AppSettings>,
  log: Log = noLog
): Promise<Investor> {
  const who = c.name;
  const audience: Audience = c.audience ? audienceOf(c) : audienceOf(settings);
  const exp = isExp(audience);
  const evidence: string[] = [];
  const sources = new Set<string>([c.sourceUrl].filter(Boolean));
  evidence.push(`DISCOVERY SOURCE (${c.sourceUrl}): ${c.sourceTitle}\n${c.snippet}`);

  // 1. LinkedIn (public profile URL via search engine — never scraped)
  let linkedin = c.linkedinUrl;
  if (!linkedin && settings?.lookupLinkedInProfiles !== false && c.investorType !== 'Angel Group' && c.name !== c.firm) {
    linkedin = await findLinkedInProfile(c.name, c.firm).catch(() => '');
    if (linkedin) log('research', `Found public LinkedIn profile`, 'info', who);
  }

  // 2. Website
  let website = c.websiteUrl;
  // Only spend a search credit on finding the website when we don't already have it.
  const look = website ? { url: '', snippets: [] as SearchResult[] } : await findFirmWebsite(c.firm, c.name, exp).catch(() => ({ url: '', snippets: [] as SearchResult[] }));
  if (!website) website = look.url;
  for (const r of look.snippets.slice(0, 6)) {
    evidence.push(`SEARCH (${r.url}): ${r.title} — ${r.snippet}`);
  }

  const emails = new Set<string>();
  const phones: string[] = []; // contact page first, then the rest
  let crawl = { title: '', description: '', excerpt: '', url: website };
  if (website && canFetch(website)) {
    const home = await readPage(website, 6000);
    if (home.text) {
      sources.add(home.url);
      crawl = { title: home.title, description: home.description, excerpt: home.text.slice(0, 1500), url: home.url };
      home.emails.forEach(e => emails.add(e));
      phones.push(...(home.phones || []));
      evidence.push(`WEBSITE ${home.url} — ${home.title}\n${home.description}\n${home.text}`);
      const subs = pickUsefulSubpages(home, 3);
      // no contact link on the home page? most sites still have /contact
      if (!home.emails.length && !subs.some(u => /contact/i.test(u))) {
        try {
          subs.push(new URL('/contact', home.url).toString());
        } catch {
          /* ignore */
        }
      }
      for (const sub of subs) {
        const p = await readPage(sub, 4000);
        if (p.text) {
          sources.add(p.url);
          p.emails.forEach(e => emails.add(e));
          if (/contact/i.test(p.url)) phones.unshift(...(p.phones || []));
          else phones.push(...(p.phones || []));
          evidence.push(`PAGE ${p.url}\n${p.text.slice(0, 3000)}`);
        }
      }
      log('research', `Read ${website.replace(/^https?:\/\//, '').slice(0, 50)} (${home.via})`, 'info', who);
    } else {
      log('research', `Could not read ${website}`, 'warn', who);
    }
  }

  // Still nothing on their site? One search for emails published elsewhere on the web
  // (press pages, directories, event pages) — kept only if it's on the firm's own domain.
  const root = siteRootOf(website);
  const trustedSite = !!c.websiteUrl || siteMatchesFirm(root, c.firm, c.name);
  const webEmails = new Set<string>();
  if (root && trustedSite && ![...emails].some(e => e.endsWith('@' + root) || e.endsWith('.' + root))) {
    const firstLast = c.name.split(/\s+/).filter(Boolean);
    const q = `"@${root}"${firstLast.length > 1 ? ` OR "${firstLast[0]}" "${firstLast[firstLast.length - 1]}" email` : ''}`;
    const { results } = await webSearch(q, 8).catch(() => ({ results: [] as SearchResult[] }));
    for (const r of results) {
      for (const e of extractEmails(`${r.title} ${r.snippet}`)) {
        if (e.endsWith('@' + root) || e.endsWith('.' + root)) {
          webEmails.add(e);
          emails.add(e);
          evidence.push(`SEARCH (${r.url}): ${r.title} — ${r.snippet}`);
        }
      }
    }
    if (webEmails.size) log('research', `Found a published email on the web for ${root}`, 'info', who);
  }

  // an email seen in the search result that led us here counts too (same-domain rule applies below)
  extractEmails(`${c.sourceTitle || ''} ${c.snippet || ''}`).forEach(e => emails.add(e));

  const evidenceText = evidence.join('\n\n---\n\n').slice(0, 8000);
  const emailList = [...emails];

  const out = await chatJson<any>(
    exp
      ? `You research FUNDRAISING EXPERTS — people whose job is raising money for startups (fundraising consultants / advisors, capital-raising advisors, investor-introduction partners) — who could help ${s.name} raise its pre-seed round. Today is ${today()}. ${HONESTY_RULES}`
      : `You are a VC research analyst + fundraising copywriter for ${s.name}. Today is ${today()}. ${HONESTY_RULES}`,
    `STARTUP:
${startupBrief(s)}

${exp ? 'FUNDRAISING EXPERT' : 'INVESTOR'} CANDIDATE: ${c.name} — ${c.title || ''} @ ${c.firm} (${c.investorType})
Why discovered: ${c.whyRelevant}

EVIDENCE COLLECTED FROM THE PUBLIC WEB:
${evidenceText}

Emails found on their site: ${emailList.join(', ') || 'none'}
Phones found on their site: ${[...new Set(phones)].slice(0, 4).join(', ') || 'none'}

${geoRule(targetGeo(s.location))}
${NO_UPFRONT_RULE}

Return JSON:
{
 "profile": {
   "title": "", "firm": "", "investorType": "${typeList(audience)}",
   "location": "", "stage": "${exp ? 'stages they help with: ' : ''}Pre-seed | Seed | Series A | Growth | All Stages | Unknown",
   ${
     exp
       ? `"checkSizeFormatted": "their fees / pricing ONLY if published (e.g. '$3k/month retainer', 'fixed fee', 'success fee'), else Unknown", "checkSizeMin": 0, "checkSizeMax": 0,
   "industries": ["sectors they work in, FROM EVIDENCE"], "portfolio": ["startups / clients they helped, named IN EVIDENCE"],
   "recentInvestments": [{"name":"client or raise they helped with","year":"","sector":"","note":"amount raised etc. only if in evidence"}],
   "thesis": "the services they offer and how they work, from evidence", "contactRoute": "best legitimate route: e.g. 'Email', 'Book a call on website', 'Contact form', 'LinkedIn connection'",
   "email": "ONLY an email from the list above that belongs to this person/firm, else \\"\\"",`
       : `"checkSizeFormatted": "e.g. $25k - $100k, or Unknown", "checkSizeMin": number or 0, "checkSizeMax": number or 0,
   "industries": ["focus areas FROM EVIDENCE"], "portfolio": ["portfolio companies named IN EVIDENCE"],
   "recentInvestments": [{"name":"","year":"","sector":"","note":""}],
   "thesis": "their stated thesis, from evidence", "contactRoute": "best legitimate route: e.g. 'Email partner', 'Website pitch form', 'LinkedIn connection', 'Warm intro preferred'",
   "email": "ONLY an email from the list above that belongs to this investor/firm, else \\"\\"",`
   }
   "twitter": "", "keyQuotes": ["short quotes copied from evidence"],
   "country": "country they are based in, from evidence, else \\"\\"",
   "upfrontFee": "yes | no | unknown — yes ONLY if evidence shows founders must pay them before anything happens (retainer, monthly fee, application / pitch / membership fee, paid program, due-diligence fee)",
   "feeModel": "${exp ? 'how they charge, from evidence (e.g. success fee only, commission on funds raised, retainer + success fee, hourly), else Unknown' : 'any fee they charge founders (e.g. pitch fee, membership), else None'}"
 },
 "isRealInvestor": true/false (${exp ? 'false if they are a lawyer / law firm, accountant, designer, agency, software tool, or do NOT actually raise money for startups' : 'false if evidence suggests this is not an active investor'}),
 "fit": {"thesisMatch":0-100,"stageMatch":0-100,"sectorMatch":0-100,"checkSizeMatch":0-100,"synergyMatch":0-100,"total":0-100,
         "verdict":"one sentence","whyInvest":["3 evidence-based reasons ${exp ? 'they could help' : ''}"],"hesitations":["2 honest concerns"],"keyTalkingPoint":"the single best hook for outreach"},
 "researchNotes": "4-6 sentences: who they are, ${exp ? 'what fundraising help they offer and for whom' : 'what they invest in'}, what you could NOT verify",
 ${OUTREACH_SPEC(s, settings, audience)}
}
${
  exp
    ? `Fit fields for an expert: thesisMatch = how much they specialise in startup fundraising; stageMatch = they help pre-seed/seed companies; sectorMatch = experience with consumer / kids / family / fintech / edtech; checkSizeMatch = cost fit: 90+ if paid only from results (success fee / commission on money raised, no upfront cost), 50 if unknown, 20 or less if they need a retainer or any upfront payment; synergyMatch = track record and investor network shown in evidence.
Scoring guide: 80+ = clearly helps early-stage consumer startups raise, with evidence of results; 55-79 = general startup fundraising help; <55 = weak, unclear, late-stage only or big-company only. Be strict when evidence is thin.`
    : `Scoring guide: 80+ = clear thesis + stage match for a kids/family consumer app; 55-79 = adjacent (consumer, edtech, fintech generalist); <55 = weak/unclear. Be strict when evidence is thin.`
}`,
    3500
  );

  const p = out?.profile || {};
  const fit = normalizeFit(out?.fit);
  const pEarly = out?.profile || {};
  const realFundraiser = exp && looksLikeFundraiser({ title: str(pEarly.title, 120) || c.title, firm: str(pEarly.firm, 120) || c.firm, thesis: str(pEarly.thesis, 800), feeModel: str(pEarly.feeModel, 160) });
  if (out?.isRealInvestor === false) {
    // a clear fundraiser keeps their score (just a warning); otherwise the score drops
    if (!realFundraiser) {
      fit.total = Math.min(fit.total, 30);
      fit.status = 'cold';
    }
    fit.hesitations = [
      exp ? 'Evidence suggests they may not really offer fundraising help — verify before contacting.' : 'Evidence suggests this may not be an active investor — verify before contacting.',
      ...fit.hesitations
    ].slice(0, 5);
  }
  // Location + money rules
  const geo = targetGeo(s.location);
  const country = str(p.country, 80);
  const outside = outsideTarget(`${country} ${str(p.location, 120)}`, geo);
  if (outside) {
    fit.total = Math.min(fit.total, 20);
    fit.status = 'cold';
    fit.hesitations = [`Based outside the ${geo.country} (${country || str(p.location, 80)}).`, ...fit.hesitations].slice(0, 5);
  }
  const upfrontFee: 'yes' | 'no' | 'unknown' = /^yes/i.test(str(p.upfrontFee)) ? 'yes' : /^no/i.test(str(p.upfrontFee)) ? 'no' : 'unknown';
  const feeModel = str(p.feeModel, 160);
  const who2 = { name: c.name, firm: str(p.firm, 120) || c.firm, title: str(p.title, 120) || c.title, investorType: str(p.investorType), thesis: str(p.thesis, 800), feeModel: str(p.feeModel, 160) };
  // lawyers / vendors are always out; an AI "no" alone only counts if nothing says they raise money
  const notExpert = exp && (isNotFundraisingExpert(who2) || (out?.isRealInvestor === false && !looksLikeFundraiser(who2)));
  if (notExpert) {
    fit.total = Math.min(fit.total, 10);
    fit.status = 'cold';
    fit.hesitations = ['Not a fundraising expert (e.g. law firm, accountant, designer or agency) — filtered out.', ...fit.hesitations].slice(0, 5);
  }
  if (upfrontFee === 'yes') {
    fit.total = Math.min(fit.total, 15);
    fit.status = 'cold';
    fit.hesitations = [`Asks for money upfront${feeModel ? ` (${feeModel})` : ''} — filtered out.`, ...fit.hesitations].slice(0, 5);
  }

  const email = str(p.email, 200).toLowerCase();
  // Only keep an email that was really published AND belongs to this investor's own site (or a personal mailbox).
  const siteRoot = (() => {
    try {
      return new URL(website).hostname.replace(/^www\./, '').split('.').slice(-2).join('.');
    } catch {
      return '';
    }
  })();
  const emailDomain = email.split('@')[1] || '';
  const domainOk = /^(gmail|googlemail|outlook|hotmail|icloud|yahoo|proton|protonmail)\./.test(emailDomain) || (!!siteRoot && emailDomain.endsWith(siteRoot));
  const aiPick = email && emailList.includes(email) && domainOk && !(webEmails.has(email) && !emailDomain.endsWith(siteRoot)) ? email : '';
  // The AI sometimes skips a perfectly good firm inbox — pick the best published one ourselves.
  const verifiedEmail = aiPick || (trustedSite ? bestEmail(emailList, c.name, siteRoot) : '');
  const portfolio = arr(p.portfolio, 25);
  const now = new Date().toISOString();
  const li = buildLinkedIn(audience, { name: c.name, firm: str(p.firm, 120) || c.firm }, settings?.bookingLink);

  return {
    id: uid('inv'),
    emailSearchV: EMAIL_SEARCH_V,
    name: c.name,
    title: str(p.title, 120) || c.title || (exp ? 'Fundraising expert' : 'Investor'),
    firm: str(p.firm, 120) || c.firm,
    investorType: expType(asType(p.investorType || c.investorType), exp),
    audience,
    website: website || '',
    email: verifiedEmail,
    // a phone only counts if it is on their own website
    phone: trustedSite ? [...new Set(phones)][0] || '' : '',
    linkedin: linkedin || '',
    twitter: str(p.twitter, 80),
    location: str(p.location, 120) || c.location || '',
    country: country || (outside ? '' : geo.country),
    upfrontFee,
    feeModel,
    stage: asStage(p.stage),
    checkSizeFormatted: str(p.checkSizeFormatted, 60) || 'Unknown',
    checkSizeMin: Number(p.checkSizeMin) || 0,
    checkSizeMax: Number(p.checkSizeMax) || 0,
    industries: arr(p.industries, 12),
    portfolio,
    recentInvestments: (Array.isArray(p.recentInvestments) ? p.recentInvestments : []).slice(0, 6).map((r: any) => ({
      name: str(r?.name, 80),
      year: str(r?.year, 10),
      sector: str(r?.sector, 80),
      note: str(r?.note, 200)
    })).filter((r: any) => r.name),
    thesis: str(p.thesis, 800),
    contactRoute: str(p.contactRoute, 120) || (verifiedEmail ? 'Email' : linkedin ? 'LinkedIn connection' : 'Website'),
    activePartner: c.name,
    fitScore: fit,
    researchNotes: str(out?.researchNotes, 2000),
    extractedData: {
      rawUrl: crawl.url || c.sourceUrl,
      crawledAt: now,
      pageTitle: crawl.title || c.sourceTitle,
      metaDescription: crawl.description,
      extractedTextExcerpt: crawl.excerpt || c.snippet,
      keyQuotes: arr(p.keyQuotes, 5),
      portfolioFound: portfolio,
      detectedCheckSize: str(p.checkSizeFormatted, 60),
      detectedContactEmail: verifiedEmail
    },
    sourceUrls: [...sources].slice(0, 8),
    linkedinNote: li.note,
    linkedinMessage: li.message,
    outreach: {
      status: fit.status === 'hot' ? 'hot' : fit.status === 'warm' ? 'warm' : 'researched',
      sequenceGenerated: true,
      sequences: buildEmails(audience, { name: c.name, firm: str(p.firm, 120) || c.firm }, str(out?.personalLine, 400), settings?.bookingLink),
      templateV: TEMPLATE_V,
      sentStepsCount: 0,
      // never auto-email someone who wants money upfront or is outside the target country
      autoPaused: upfrontFee === 'yes' || outside || notExpert ? true : undefined
    },
    tags: ['AI researched', c.investorType, linkedin ? 'LinkedIn found' : '', upfrontFee === 'yes' ? 'Asks for upfront fee' : '', outside ? 'Outside target country' : '', notExpert ? 'Not a fundraising expert' : ''].filter(Boolean) as string[],
    researchDepth: 'deep',
    createdAt: now,
    updatedAt: now
  };
}

function investorBrief(i: Investor): string {
  const exp = isExp(i.audience);
  return [
    `Name: ${i.name} — ${i.title} @ ${i.firm} (${i.investorType || ''})${exp ? ' — FUNDRAISING EXPERT (helps startups raise; not an investor)' : ''}`,
    `Location: ${i.location}`,
    exp ? `Stages they help: ${i.stage}; Fees: ${i.checkSizeFormatted}` : `Stage: ${i.stage}; Check: ${i.checkSizeFormatted}`,
    `Industries: ${i.industries.join(', ')}`,
    `${exp ? 'Past clients' : 'Portfolio'}: ${i.portfolio.join(', ')}`,
    `${exp ? 'Services' : 'Thesis'}: ${i.thesis}`,
    i.feeModel ? `How they charge: ${i.feeModel}` : '',
    `Research notes: ${i.researchNotes}`,
    i.extractedData?.extractedTextExcerpt ? `Website excerpt: ${i.extractedData.extractedTextExcerpt.slice(0, 1500)}` : ''
  ].join('\n');
}

export async function scoreInvestor(s: StartupProfile, i: Investor): Promise<{ fitScore: InvestorFitScore; researchNotes: string }> {
  const out = await chatJson<any>(
    isExp(i.audience)
      ? `You score how well a FUNDRAISING EXPERT could help ${s.name} raise its round. thesisMatch = fundraising specialty, stageMatch = helps pre-seed/seed, sectorMatch = consumer/kids/fintech/edtech experience, checkSizeMatch = affordable for a pre-seed startup, synergyMatch = track record + investor network. ${HONESTY_RULES}`
      : `You are a VC analyst scoring investor fit for ${s.name}. ${HONESTY_RULES}`,
    `STARTUP:\n${startupBrief(s)}\n\n${isExp(i.audience) ? 'FUNDRAISING EXPERT' : 'INVESTOR'}:\n${investorBrief(i)}\n\nReturn JSON: {"fit": {"thesisMatch":0-100,"stageMatch":0-100,"sectorMatch":0-100,"checkSizeMatch":0-100,"synergyMatch":0-100,"total":0-100,"verdict":"","whyInvest":["3"],"hesitations":["2"],"keyTalkingPoint":""}, "researchNotes": "updated 3-5 sentence notes"}
Be strict when information is thin.`,
    2000
  );
  return { fitScore: normalizeFit(out?.fit), researchNotes: str(out?.researchNotes, 2000) || i.researchNotes };
}

export async function generateOutreach(
  s: StartupProfile,
  i: Investor,
  settings?: Partial<AppSettings>,
  opts: { requireAI?: boolean } = {}
): Promise<{ sequences: EmailSequenceStep[]; linkedinNote: string; linkedinMessage: string; templateV: number }> {
  const audience = audienceOf(i);
  let personal = '';
  try {
    const out = await chatJson<any>(
      `You write ONE personal sentence for ${s.name}'s outreach email. ${HONESTY_RULES}`,
      `${isExp(audience) ? 'FUNDRAISING EXPERT' : 'INVESTOR'}:\n${investorBrief(i)}\nBest hook: ${i.fitScore?.keyTalkingPoint || ''}\n\nReturn JSON: {${OUTREACH_SPEC(s, settings, audience)}}`,
      400
    );
    personal = str(out?.personalLine, 400);
  } catch (e) {
    if (opts.requireAI) throw e; // background upgrade: wait for the AI rather than drop the personal sentence
    personal = ''; // the template still works without the personal sentence
  }
  const li = buildLinkedIn(audience, { name: i.name, firm: i.firm }, settings?.bookingLink);
  return {
    sequences: buildEmails(audience, { name: i.name, firm: i.firm }, personal, settings?.bookingLink),
    linkedinNote: li.note,
    linkedinMessage: li.message,
    templateV: TEMPLATE_V
  };
}

// ---------------------------------------------------------------- One-click autonomous run
const jobs = new Map<string, AgentJob & { cancel?: boolean }>();

export function getJob(id: string) {
  return jobs.get(id);
}
export function latestJob() {
  return [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}
export function cancelJob(id: string) {
  const j = jobs.get(id);
  if (j && j.status === 'running') j.cancel = true;
  return !!j;
}

export function startAgentJob(
  s: StartupProfile,
  settings: AppSettings,
  existing: { name: string; firm: string }[],
  opts: { refreshProduct?: boolean; extraQueries?: string[] } = {}
): AgentJob {
  // keep memory small
  for (const [id, j] of jobs) if (j.status !== 'running' && Date.now() - Date.parse(j.startedAt) > 6 * 3600_000) jobs.delete(id);
  const running = [...jobs.values()].find(j => j.status === 'running');
  if (running) return running;

  const job: AgentJob & { cancel?: boolean } = { id: uid('job'), status: 'running', startedAt: new Date().toISOString(), progress: 0, logs: [], investors: [] };
  jobs.set(job.id, job);
  const log: Log = (phase, message, level = 'info', investorName) => {
    job.logs.push({ id: uid('log'), timestamp: new Date().toISOString(), phase, message, level, investorName });
    if (job.logs.length > 600) job.logs.splice(0, job.logs.length - 600);
  };

  (async () => {
    let startup = { ...s };
    try {
      // Phase 1
      if (opts.refreshProduct || !startup.investorKeywords?.length || !startup.linkedinSearchQueries?.length) {
        log('product', `Phase 1 — analysing ${startup.name}${startup.website ? ` (reading ${startup.website})` : ''}…`);
        const intel = await analyzeProduct(startup, settings);
        startup = { ...startup, ...intel };
        job.startupUpdate = intel;
        log('product', `Product understood (confidence ${intel.aiConfidence}%). Investor themes: ${(intel.investorKeywords || []).slice(0, 6).join(', ')}`, 'success');
      } else {
        log('product', `Using saved product intelligence for ${startup.name}`, 'info');
      }
      job.progress = 10;
      if (job.cancel) throw new Error('cancelled');

      // Phase 2
      const q = defaultQueries(startup, settings);
      const queries = [...q.linkedin.slice(0, 5), ...q.web.slice(0, 6), ...(opts.extraQueries || [])];
      log('search', `Phase 2 — running ${queries.length} searches (public LinkedIn profiles + investor websites)…`);
      const { candidates } = await discoverCandidates(
        startup,
        queries,
        existing,
        (ph, m, l, n) => {
          log(ph, m, l, n);
          if (ph === 'search') job.progress = Math.min(30, job.progress + 2);
        },
        audienceOf(settings)
      );
      job.progress = 35;
      if (!candidates.length) {
        log('extract', 'No new investors found this run. Try again later, add search keys (Tavily/Serper), or edit search queries in the Brain tab.', 'warn');
      }

      // Phase 3-5
      const target = candidates.slice(0, Math.max(1, settings.leadsPerRun || 10));
      log('research', `Phase 3-5 — researching, scoring and writing outreach for ${target.length} investors…`);
      let kept = 0;
      const PACE_MS = Number(process.env.AGENT_PACE_MS || 8000); // breathing room for free AI limits
      const failed: DiscoveryCandidate[] = [];
      const runOne = async (c: DiscoveryCandidate, retry: boolean) => {
        log('research', `${retry ? 'Retrying' : 'Researching'} ${c.name}${c.firm && c.firm !== c.name && !/independent/i.test(c.firm) ? ` (${c.firm})` : ''}…`, 'info', c.name);
        try {
          const inv = await researchCandidate(startup, c, settings, log);
          if (inv.fitScore.total < (settings.minFitScoreToKeep ?? 0)) {
            log('score', `Fit ${inv.fitScore.total}/100 — below your minimum (${settings.minFitScoreToKeep}), skipped`, 'warn', c.name);
          } else {
            job.investors.push(inv);
            kept++;
            log('score', `Fit ${inv.fitScore.total}/100 (${inv.fitScore.status.toUpperCase()}) — ${inv.fitScore.verdict}`, 'success', c.name);
            log('outreach', `Drafted 4-step email cadence + LinkedIn note${inv.email ? ` (email found: ${inv.email})` : ''}`, 'success', c.name);
          }
        } catch (e: any) {
          const msg = String(e?.message || e);
          if (/No AI key/i.test(msg)) throw e;
          if (!retry && /AI providers failed|rate limited|busy|timeout/i.test(msg)) {
            failed.push(c);
            log('research', 'AI is busy (free limit) — will retry this investor at the end', 'warn', c.name);
          } else {
            log('research', `Failed: ${msg.slice(0, 200)}`, 'error', c.name);
          }
        }
      };
      for (let idx = 0; idx < target.length; idx++) {
        if (job.cancel) throw new Error('cancelled');
        await runOne(target[idx], false);
        job.progress = Math.round(35 + ((idx + 1) / target.length) * 55);
        if (idx < target.length - 1) await new Promise(r => setTimeout(r, PACE_MS));
      }
      if (failed.length) {
        log('research', `Waiting 60 seconds, then retrying ${failed.length} investor(s) that hit the free AI limit…`, 'info');
        await new Promise(r => setTimeout(r, Number(process.env.AGENT_RETRY_WAIT_MS || 60000)));
        for (let idx = 0; idx < failed.length; idx++) {
          if (job.cancel) throw new Error('cancelled');
          await runOne(failed[idx], true);
          job.progress = Math.round(90 + ((idx + 1) / failed.length) * 9);
          if (idx < failed.length - 1) await new Promise(r => setTimeout(r, PACE_MS * 2));
        }
      }
      job.progress = 100;
      job.status = 'done';
      log('crm', `Done — ${kept} investors added to your CRM.`, 'success');
    } catch (e: any) {
      const msg = String(e?.message || e);
      job.status = msg === 'cancelled' ? 'cancelled' : 'error';
      job.error = msg;
      log('system', msg === 'cancelled' ? `Stopped. ${job.investors.length} investors were saved before stopping.` : `Run failed: ${msg}`, msg === 'cancelled' ? 'warn' : 'error');
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  })();

  return job;
}


// ---------------------------------------------------------------- Big runs (used by campaign.ts)

/** Score many candidates cheaply from their search snippets — 10 per AI request. */
export async function quickScoreCandidates(
  s: StartupProfile,
  cands: { id: string; name: string; firm: string; title: string; investorType: string; snippet: string; whyRelevant: string; location: string }[],
  audience: Audience = 'investors'
): Promise<Map<string, { score: number; reason: string; isInvestor: boolean; upfront: boolean; outside: boolean }>> {
  const exp = isExp(audience);
  const geo = targetGeo(s.location);
  const out = new Map<string, { score: number; reason: string; isInvestor: boolean; upfront: boolean; outside: boolean }>();
  if (!cands.length) return out;
  const res = await chatJson<any>(
    exp
      ? `You do a FAST first-pass check of FUNDRAISING EXPERTS who could help ${s.name} raise its round. Use only the text given. ${HONESTY_RULES}`
      : `You are a VC analyst doing a FAST first-pass fit check for ${s.name}. Use only the text given. ${HONESTY_RULES}`,
    `STARTUP:\n${startupBrief(s).slice(0, 1500)}

CANDIDATES:
${cands.map((c, i) => `[${i + 1}] ${c.name} — ${c.title} @ ${c.firm} (${c.investorType}) ${c.location}\nSeen: ${c.snippet.slice(0, 300)}\nWhy found: ${c.whyRelevant}`).join('\n\n')}

Return JSON: {"scores":[{"n":1,"score":0-100,"isInvestor":true/false,"upfrontFee":true/false,"outsideCountry":true/false,"reason":"one short sentence"}]} — one entry per candidate, same numbers.
"upfrontFee": true ONLY if the text shows they make founders pay before anything happens (retainer, monthly fee, application / pitch / membership fee, paid program). ${NO_UPFRONT_RULE}
"outsideCountry": true ONLY if the text shows they are based outside the ${geo.country}.
${
  exp
    ? `"isInvestor" here means: true ONLY if their job is raising money for startups (fundraising consultant / advisor, capital-raising advisor, investor-introduction partner, early-stage placement agent); false for lawyers / law firms, accountants, designers, agencies, software, recruiters and anyone else.
Scoring: 75+ clearly helps early-stage consumer / kids / fintech / edtech startups raise; 50-74 general startup fundraising help; <50 weak, unclear, or only late-stage / big companies. Be strict when the text is thin.`
    : `Scoring: 75+ clear thesis/stage fit for a kids/family consumer app at pre-seed; 50-74 adjacent (consumer, edtech, fintech, local angel); <50 weak or unclear. Be strict when the text is thin.`
}`,
    1500
  );
  for (const r of Array.isArray(res?.scores) ? res.scores : []) {
    const c = cands[Number(r?.n) - 1];
    if (!c) continue;
    out.set(c.id, {
      score: clamp(r.score),
      reason: str(r.reason, 300),
      isInvestor: r.isInvestor !== false,
      upfront: r.upfrontFee === true,
      outside: r.outsideCountry === true || outsideTarget(c.location, geo)
    });
  }
  return out;
}

/** Ask the AI for NEW search queries (different from ones already used) so each run finds new people. */
export async function generateSearchQueries(
  s: StartupProfile,
  settings: Partial<AppSettings>,
  used: string[],
  count = 24
): Promise<string[]> {
  if (isExp(settings.audience)) return generateExpertQueries(s, settings, used, count);
  const res = await chatJson<any>(
    `You plan investor searches for ${s.name}. ${HONESTY_RULES}`,
    `STARTUP:\n${startupBrief(s).slice(0, 2000)}
Geography: ONLY people based in the ${targetGeo(s.location).country}${targetGeo(s.location).state ? ` (extra weight on ${targetGeo(s.location).state})` : ''}. Every query must aim at the ${targetGeo(s.location).country} (name the country, a state or a city).

Queries ALREADY USED (do not repeat or lightly reword them):
${used.slice(-120).join('\n') || '(none)'}

Write ${count} NEW, varied Google queries that surface SPECIFIC investors who could fund this company. Mix:
- about a third that find PUBLIC LinkedIn profiles: must start with site:linkedin.com/in and use quoted phrases (roles like "angel investor", "partner", "principal", "scout"; themes; cities; portfolio companies like Greenlight, GoHenry, BusyKid, Step, Outschool)
- about a third find funds, angel groups and accelerators that PUBLISH an email for pitches (e.g. "send us your pitch deck", "pitch@", "deals@", "email your deck") — these are the investors we can actually email
- the rest find funds, angel groups, family offices, and "investors in <comparable company>" lists

SEARCH RULES (very important — long searches find NOBODY):
- Each query is SHORT: at most 2 quoted phrases, 2-7 words in total.
- Never put fees, commission, success fee, retainer, compliance words (COPPA), "contact", "book a call" or "LinkedIn" in a query.
- At most ONE place (a US state or city) per query.
Return JSON: {"queries":["..."]}`,
    1500
  );
  const usedSet = new Set(used.map(q => q.toLowerCase().trim()));
  return arr(res?.queries, count * 2)
    .map(q => q.trim())
    .map(q => withGeo(simplifyQuery(q), targetGeo(s.location)))
    .filter(q => q.length > 8 && !usedSet.has(q.toLowerCase()))
    .slice(0, count);
}

async function generateExpertQueries(s: StartupProfile, settings: Partial<AppSettings>, used: string[], count: number): Promise<string[]> {
  const res = await chatJson<any>(
    `You plan searches that find FUNDRAISING EXPERTS for ${s.name}. ${HONESTY_RULES}`,
    `STARTUP:\n${startupBrief(s).slice(0, 1500)}
Geography: ONLY people based in the ${targetGeo(s.location).country}${targetGeo(s.location).state ? ` (extra weight on ${targetGeo(s.location).state})` : ''}. Every query must aim at the ${targetGeo(s.location).country} (name the country, a state or a city).

Queries ALREADY USED (do not repeat or lightly reword them):
${used.slice(-120).join('\n') || '(none)'}

Write ${count} NEW, varied Google queries that surface SPECIFIC people or small firms who help startups like this raise money: fundraising consultants, fundraising advisors, capital-raising advisors and people who introduce startups to angel investors and VCs. NEVER lawyers / law firms, accountants, pitch-deck designers or agencies. Mix:
- about a third that find PUBLIC LinkedIn profiles: must start with site:linkedin.com/in and use quoted phrases (roles + themes like consumer apps, fintech, edtech, kids, or cities)
- about a third that find experts with their own fundraising / capital-raising advisory website (e.g. "fundraising consultant" Phoenix, "capital raising advisory" startups)
- the rest: lists and directories of such experts, and experts who mention helping companies similar to this one

SEARCH RULES (very important — long searches find NOBODY):
- Each query is SHORT: at most 2 quoted phrases, 2-7 words in total.
- Never put fees, commission, success fee, retainer, compliance words (COPPA), "contact", "book a call" or "LinkedIn" in a query.
- At most ONE place (a US state or city) per query.
Return JSON: {"queries":["..."]}`,
    1500
  );
  const usedSet = new Set(used.map(q => q.toLowerCase().trim()));
  return arr(res?.queries, count * 2)
    .map(q => q.trim())
    .map(q => withGeo(simplifyQuery(q), targetGeo(s.location)))
    .filter(q => q.length > 8 && !usedSet.has(q.toLowerCase()))
    .slice(0, count);
}

/** A lightweight CRM record from a quick-scored candidate (deep research can upgrade it later). */
export function candidateToQuickInvestor(c: DiscoveryCandidate, score: number, reason: string, campaignId?: string): Investor {
  const now = new Date().toISOString();
  const status = fitStatus(score);
  const audience = audienceOf(c);
  return {
    id: uid('inv'),
    audience,
    name: c.name,
    title: c.title || (isExp(audience) ? 'Fundraising expert' : 'Investor'),
    firm: c.firm,
    investorType: c.investorType,
    website: c.websiteUrl || '',
    email: '',
    linkedin: c.linkedinUrl || '',
    location: c.location || '',
    stage: 'Unknown',
    checkSizeFormatted: 'Unknown',
    checkSizeMin: 0,
    checkSizeMax: 0,
    industries: [],
    portfolio: [],
    recentInvestments: [],
    thesis: '',
    contactRoute: c.linkedinUrl ? 'LinkedIn connection' : c.websiteUrl ? 'Website' : 'Unknown',
    activePartner: c.name,
    fitScore: {
      total: score,
      thesisMatch: score,
      stageMatch: score,
      sectorMatch: score,
      checkSizeMatch: score,
      synergyMatch: score,
      status,
      verdict: `Quick scan: ${reason || c.whyRelevant}`,
      whyInvest: c.whyRelevant ? [c.whyRelevant] : [],
      hesitations: ['Only quick-scanned from search results — open and click "Research deeply" before contacting.'],
      keyTalkingPoint: ''
    },
    researchNotes: `Found via search: ${c.sourceTitle}. ${c.snippet.slice(0, 300)}`,
    extractedData: {
      rawUrl: c.sourceUrl,
      crawledAt: now,
      pageTitle: c.sourceTitle,
      metaDescription: '',
      extractedTextExcerpt: c.snippet,
      keyQuotes: [],
      portfolioFound: [],
      detectedCheckSize: '',
      detectedContactEmail: ''
    },
    sourceUrls: [c.sourceUrl].filter(Boolean),
    outreach: { status: 'discovered', sequenceGenerated: false, sequences: [], sentStepsCount: 0 },
    tags: ['Quick scan', c.investorType],
    researchDepth: 'quick',
    quickScore: score,
    campaignId,
    createdAt: now,
    updatedAt: now
  };
}

/** Turn an existing CRM record back into a candidate so it can be deep-researched. */
export function investorToCandidate(i: Investor): DiscoveryCandidate {
  return {
    id: i.id,
    name: i.name,
    firm: i.firm,
    title: i.title,
    investorType: (i.investorType || 'Other') as InvestorType,
    audience: audienceOf(i),
    linkedinUrl: i.linkedin || '',
    websiteUrl: i.website || '',
    sourceUrl: i.sourceUrls?.[0] || i.extractedData?.rawUrl || '',
    sourceTitle: i.extractedData?.pageTitle || '',
    snippet: i.extractedData?.extractedTextExcerpt || i.researchNotes || '',
    whyRelevant: i.fitScore?.whyInvest?.[0] || '',
    location: i.location || ''
  };
}
