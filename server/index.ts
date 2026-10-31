/**
 * SafeCart Kids Investor Agent — backend server.
 * Zero npm dependencies at runtime: plain Node.js (v20+) http + fetch.
 * Serves the built React app from /dist and the agent API under /api.
 */
import './env'; // must be first: loads .env for local runs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { aiConfigured, aiProviderNames } from './ai';
import { searchProviderNames, webSearch } from './search';
import { emailProvider, sendEmail } from './email';
import { loadState, saveState, storageInfo, flushNow, mergeInvestors, clearInvestors, restoreFromBackup, shutdownSave } from './store';
import { audienceOf, AUDIENCE_TEXT } from '../src/data/audience';
import { gmailConfigured, gmailSheet, gmailTest } from './gmail';
import { excludedReason } from '../src/data/filters';
import { targetGeo } from '../src/data/geo';
import { startCampaign, startUpgrade, getCampaign, pauseCampaign, resumeCampaign, resumeOnBoot } from './campaign';
import { startAutomation, runAutomationNow, automationStatus } from './automation';
import {
  analyzeProduct,
  discoverCandidates,
  researchCandidate,
  scoreInvestor,
  generateOutreach,
  findLinkedInProfile,
  startAgentJob,
  getJob,
  latestJob,
  cancelJob,
  defaultQueries
} from './agent';
import { investorToCandidate } from './agent';
import type { HealthInfo, Investor } from '../src/types';

const PORT = Number(process.env.PORT) || 8080;
const DIST = path.resolve(process.env.STATIC_DIR || path.join(process.cwd(), 'dist'));
const PASSWORD = (process.env.APP_PASSWORD || '').trim();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

const wantsGzip = (req?: http.IncomingMessage) => /\bgzip\b/.test(String(req?.headers['accept-encoding'] || ''));

/** JSON reply — compressed when the browser accepts it (Render's free plan counts every byte sent). */
function send(res: http.ServerResponse, status: number, data: unknown, req?: http.IncomingMessage) {
  const body = JSON.stringify(data);
  if (body.length > 1024 && wantsGzip(req)) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
    res.end(zlib.gzipSync(body));
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const gzCache = new Map<string, Buffer>();

async function readBody(req: http.IncomingMessage, limit = 8 * 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

function authorized(req: http.IncomingMessage): boolean {
  if (!PASSWORD) return true;
  const given = String(req.headers['x-app-password'] || '');
  const a = Buffer.from(crypto.createHash('sha256').update(given).digest('hex'));
  const b = Buffer.from(crypto.createHash('sha256').update(PASSWORD).digest('hex'));
  return crypto.timingSafeEqual(a, b);
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = path.join(DIST, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Backend is running. Frontend not built yet — run `npm run build`.');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const cache = /\/assets\//.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache';
  if (/\.(js|css|html|svg|json|txt|map)$/.test(ext) && wantsGzip(req)) {
    let gz = gzCache.get(file);
    if (!gz) {
      gz = zlib.gzipSync(fs.readFileSync(file), { level: 9 });
      gzCache.set(file, gz);
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
    res.end(gz);
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
  fs.createReadStream(file).pipe(res);
}

type Handler = (body: any, params: Record<string, string>) => Promise<unknown> | unknown;
const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
function route(method: string, pathPattern: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp('^' + pathPattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, pattern, keys, handler });
}

const need = (cond: any, msg: string) => {
  if (!cond) throw Object.assign(new Error(msg), { status: 400 });
};

// ------------------------------------------------------------------ API
route('GET', '/api/health', (): HealthInfo => ({
  ok: true,
  ai: { configured: aiConfigured(), providers: aiProviderNames() },
  search: { providers: searchProviderNames() },
  email: { configured: emailProvider() !== 'none', provider: emailProvider() },
  storage: storageInfo(),
  passwordRequired: Boolean(PASSWORD)
}));

route('GET', '/api/state', body => {
  const s = loadState();
  // ?since=<updatedAt the browser already has> → only what changed (usually nothing), to save bandwidth
  if (body.since) {
    if (body.since === s.updatedAt) return { unchanged: true, updatedAt: s.updatedAt };
    const cutoff = (Date.parse(body.since) || 0) - 5 * 60_000; // 5 min slack for clock differences
    return {
      startup: s.startup,
      settings: s.settings,
      updatedAt: s.updatedAt,
      changed: s.investors.filter((i: any) => (Date.parse(i.updatedAt || i.createdAt) || 0) >= cutoff),
      ids: s.investors.map((i: any) => i.id)
    };
  }
  return { startup: s.startup, investors: s.investors, settings: s.settings, updatedAt: s.updatedAt };
});
route('PUT', '/api/state', body => {
  need(body && typeof body === 'object', 'body required');
  // investors are MERGED (newest copy of each wins) so background jobs and the browser never overwrite each other
  if (body.clearAll) clearInvestors();
  if (Array.isArray(body.investors) || Array.isArray(body.deletedIds)) {
    mergeInvestors(Array.isArray(body.investors) ? body.investors : [], Array.isArray(body.deletedIds) ? body.deletedIds : []);
  }
  const s = saveState({ startup: body.startup, settings: body.settings });
  return { ok: true, updatedAt: s.updatedAt };
});

// ---- big runs (100-200+ investors, resumable)
route('GET', '/api/campaign', () => ({ campaign: getCampaign() }));
route('POST', '/api/campaign/start', body => {
  need(body.startup?.name, 'startup required');
  startCampaign(body.startup, body.settings || {}, { target: Number(body.target) || 100, mode: body.mode === 'quick' ? 'quick' : 'deep' });
  return { campaign: getCampaign() };
});
route('POST', '/api/campaign/upgrade', body => {
  need(body.startup?.name, 'startup required');
  const r = startUpgrade(body.startup, body.settings || {}, Number(body.count) || 20);
  return { campaign: r.campaign ? getCampaign() : null, available: r.available };
});
route('POST', '/api/campaign/pause', () => ({ ok: pauseCampaign(), campaign: getCampaign() }));
route('POST', '/api/campaign/resume', () => ({ ok: resumeCampaign(), campaign: getCampaign() }));

// ---- upgrade a quick-scanned investor to full research (keeps the same record)
route('POST', '/api/research-investor', async body => {
  need(body.startup?.name && body.investor?.id, 'startup and investor required');
  const inv = await researchCandidate(body.startup, investorToCandidate(body.investor), body.settings);
  inv.id = body.investor.id;
  inv.createdAt = body.investor.createdAt || inv.createdAt;
  inv.quickScore = body.investor.quickScore;
  inv.campaignId = body.investor.campaignId;
  const o = body.investor.outreach || {};
  const keep: any = {};
  for (const k of ['linkedinRequestSentAt', 'linkedinAcceptedAt', 'linkedinMessagedAt', 'autoPaused', 'responseNotes', 'replyDate']) if (o[k]) keep[k] = o[k];
  if (['contacted', 'replied', 'meeting', 'diligence', 'passed'].includes(o.status)) Object.assign(keep, { status: o.status });
  inv.outreach = { ...inv.outreach, ...keep };
  inv.updatedAt = new Date().toISOString();
  mergeInvestors([inv]);
  return { investor: inv };
});

// ---- automatic outreach
route('GET', '/api/automation/status', async () => await automationStatus());
route('POST', '/api/automation/run', async () => await runAutomationNow());

route('POST', '/api/product/analyze', async body => {
  need(body.startup?.name, 'startup required');
  return { intel: await analyzeProduct(body.startup, body.settings) };
});

route('POST', '/api/discover', async body => {
  need(body.startup?.name, 'startup required');
  let queries: string[] = Array.isArray(body.queries) ? body.queries.filter((q: any) => typeof q === 'string' && q.trim()) : [];
  if (body.query) {
    const q = String(body.query).trim();
    queries = body.mode === 'linkedin' && !/site:/i.test(q) ? [`site:linkedin.com/in ${q}`] : [q];
  }
  if (!queries.length) {
    const d = defaultQueries(body.startup, body.settings);
    queries = body.mode === 'linkedin' ? d.linkedin : body.mode === 'web' ? d.web : [...d.linkedin.slice(0, 3), ...d.web.slice(0, 3)];
  }
  const logs: string[] = [];
  const { candidates, rawResults } = await discoverCandidates(body.startup, queries.slice(0, 10), body.existing || [], (_p, m) => logs.push(m), audienceOf(body.settings));
  return { candidates, resultsSearched: rawResults.length, queries, logs };
});

route('POST', '/api/research', async body => {
  need(body.startup?.name && body.candidate?.name, 'startup and candidate required');
  return { investor: await researchCandidate(body.startup, body.candidate, body.settings) };
});

route('POST', '/api/score', async body => {
  need(body.startup?.name && body.investor?.name, 'startup and investor required');
  return await scoreInvestor(body.startup, body.investor);
});

route('POST', '/api/outreach', async body => {
  need(body.startup?.name && body.investor?.name, 'startup and investor required');
  return await generateOutreach(body.startup, body.investor, body.settings);
});

route('POST', '/api/linkedin/find', async body => {
  need(body.name, 'name required');
  return { linkedin: await findLinkedInProfile(String(body.name), String(body.firm || '')) };
});

route('POST', '/api/search/raw', async body => {
  need(body.query, 'query required');
  return await webSearch(String(body.query), Math.min(Number(body.max) || 10, 20));
});

route('POST', '/api/email/send', async body => {
  need(body.to && body.subject && body.body, 'to, subject and body required');
  return await sendEmail(String(body.to), String(body.subject), String(body.body), body.replyTo, body.fromName, body.label);
});

// ---- "Open in Google Sheets": the current list as a new Google Sheet in your Drive (via the Gmail helper)
route('POST', '/api/sheet', async body => {
  if (!gmailConfigured()) throw Object.assign(new Error('the Gmail helper script is not connected to this server. Add GMAIL_SCRIPT_URL and GMAIL_SCRIPT_SECRET to your hosting variables (Railway / Render → Environment) and redeploy.'), { status: 400 });
  const st = loadState();
  // one spreadsheet, one tab per list — the list you are looking at comes first
  const first = audienceOf(body);
  const order: ('investors' | 'experts')[] = first === 'experts' ? ['experts', 'investors'] : ['investors', 'experts'];
  const tabs = [
    ...order.map(aud => sheetTab(st.investors.filter((i: Investor) => audienceOf(i) === aud), aud)),
    sheetTab(st.investors, 'all') // 3rd tab: everyone together, with a Type column
  ];
  const date = new Date().toISOString().slice(0, 10);
  const r = await gmailSheet(`${st.startup?.name || 'Startup'} — Investors & Fundraising Experts — ${date}`, tabs);
  return { url: r.url, rows: r.rows, tabs: r.tabs };
});

// ---- Gmail helper "Test connection" (Settings)
route('GET', '/api/gmail/test', async () => await gmailTest());

/** Everything on the person's full profile, one row each (best fit first). */
function sheetTab(list: Investor[], aud: 'investors' | 'experts' | 'all') {
  const both = aud === 'all';
  const I = AUDIENCE_TEXT.investors;
  const E = AUDIENCE_TEXT.experts;
  const T = both ? I : AUDIENCE_TEXT[aud];
  /** heading for a field that is named differently for investors and experts */
  const lbl = (inv: string, exp: string) => (both ? (inv === exp ? inv : `${inv} / ${exp}`) : aud === 'experts' ? exp : inv);
  const geo = targetGeo(loadState().startup?.location);
  const d = (x?: string) => (x ? String(x).slice(0, 10) : '');
  const cols: [string, (i: Investor) => string | number][] = [
    ['Type', i => AUDIENCE_TEXT[audienceOf(i)].label],
    ['Name', i => i.name],
    ['Title', i => i.title],
    [lbl('Firm', 'Company'), i => i.firm],
    [lbl('Investor type', 'Expert type'), i => i.investorType || ''],
    ['Filtered out?', i => excludedReason(i, geo) || 'no'],
    ['Fit score', i => i.fitScore?.total ?? ''],
    ['Fit', i => i.fitScore?.status || ''],
    ['Verdict', i => i.fitScore?.verdict || ''],
    [`${lbl(I.fit.thesis, E.fit.thesis)} match`, i => i.fitScore?.thesisMatch ?? ''],
    [`${lbl(I.fit.stage, E.fit.stage)} match`, i => i.fitScore?.stageMatch ?? ''],
    [`${lbl(I.fit.sector, E.fit.sector)} match`, i => i.fitScore?.sectorMatch ?? ''],
    [`${lbl(I.fit.check, E.fit.check)} match`, i => i.fitScore?.checkSizeMatch ?? ''],
    [`${lbl(I.fit.synergy, E.fit.synergy)} match`, i => i.fitScore?.synergyMatch ?? ''],
    [lbl(I.field.why, E.field.why), i => (i.fitScore?.whyInvest || []).join(' | ')],
    ['Concerns', i => (i.fitScore?.hesitations || []).join(' | ')],
    ['Best opening hook', i => i.fitScore?.keyTalkingPoint || ''],
    ['Email', i => i.email || ''],
    ['Phone', i => i.phone || ''],
    ['LinkedIn', i => i.linkedin || ''],
    ['Twitter / X', i => i.twitter || ''],
    ['Website', i => i.website || ''],
    ['Best way to contact', i => i.contactRoute || ''],
    ['Location', i => i.location || ''],
    ['Country', i => i.country || ''],
    [lbl(I.field.stage, E.field.stage), i => i.stage || ''],
    [lbl(I.field.check, E.field.check), i => i.checkSizeFormatted || ''],
    ['How they charge', i => i.feeModel || ''],
    ['Asks for money upfront?', i => (i.upfrontFee === 'yes' ? 'YES — filtered out' : i.upfrontFee || 'unknown')],
    ['Industries', i => (i.industries || []).join(', ')],
    [lbl(I.field.portfolio, E.field.portfolio), i => (i.portfolio || []).join(', ')],
    [lbl('Recent investments', 'Raises / clients they helped'), i => (i.recentInvestments || []).map(r => [r.name, r.year, r.sector, r.note].filter(Boolean).join(' · ')).join(' | ')],
    [lbl(I.field.thesis, E.field.thesis), i => i.thesis || ''],
    ['Research notes', i => i.researchNotes || ''],
    ['Key quotes', i => (i.extractedData?.keyQuotes || []).join(' | ')],
    ['Research', i => (i.researchDepth === 'quick' ? 'Quick scan only' : 'Deep research')],
    ['Quick-scan score', i => i.quickScore ?? ''],
    ['Outreach status', i => i.outreach?.status || ''],
    ['Emails sent', i => `${i.outreach?.sentStepsCount || 0} of ${i.outreach?.sequences?.length || 0}`],
    ['Auto-email', i => (i.outreach?.autoPaused ? 'paused' : 'on')],
    ['Last contacted', i => d(i.outreach?.lastContactedDate)],
    ['Next follow-up', i => d(i.outreach?.nextFollowUpDate)],
    ['Replied on', i => d(i.outreach?.replyDate)],
    ['Reply / meeting notes', i => i.outreach?.responseNotes || ''],
    ['LinkedIn request sent', i => d(i.outreach?.linkedinRequestSentAt)],
    ['LinkedIn accepted', i => d(i.outreach?.linkedinAcceptedAt)],
    ['LinkedIn messaged', i => d(i.outreach?.linkedinMessagedAt)],
    ['LinkedIn note', i => i.linkedinNote || ''],
    ['LinkedIn message', i => i.linkedinMessage || '']
  ];
  for (let k = 0; k < 4; k++) {
    cols.push([`Email ${k + 1} subject`, i => i.outreach?.sequences?.[k]?.subject || '']);
    cols.push([`Email ${k + 1} (day ${[0, 4, 10, 21][k]})`, i => i.outreach?.sequences?.[k]?.body || '']);
    cols.push([`Email ${k + 1} sent`, i => d(i.outreach?.sequences?.[k]?.sentAt)]);
  }
  cols.push(
    ['Website page title', i => i.extractedData?.pageTitle || ''],
    ['Sources', i => (i.sourceUrls || []).join(' ')],
    ['Tags', i => (i.tags || []).join(', ')],
    ['Added on', i => d(i.createdAt)],
    ['Updated on', i => d(i.updatedAt)]
  );
  // shown first: people you can work with, best fit first; filtered-out ones at the bottom
  const out = (i: Investor) => (excludedReason(i, geo) ? 1 : 0);
  const sorted = [...list].sort((a, b) => out(a) - out(b) || (b.fitScore?.total || 0) - (a.fitScore?.total || 0));
  void T;
  return { name: both ? 'All (Investors + Experts)' : aud === 'experts' ? 'Fundraising Experts' : 'Investors', headers: cols.map(c => c[0]), rows: sorted.map(i => cols.map(c => c[1](i) ?? '')) };
}

route('POST', '/api/agent/run', body => {
  need(body.startup?.name, 'startup required');
  const job = startAgentJob(body.startup, body.settings || {}, body.existing || [], {
    refreshProduct: Boolean(body.refreshProduct),
    extraQueries: Array.isArray(body.extraQueries) ? body.extraQueries : []
  });
  return { jobId: job.id };
});
route('GET', '/api/agent/jobs/latest', () => ({ job: latestJob() || null }));
route('GET', '/api/agent/jobs/:id', (_b, p) => {
  const job = getJob(p.id);
  if (!job) throw Object.assign(new Error('job not found (server may have restarted)'), { status: 404 });
  return { job };
});
route('POST', '/api/agent/jobs/:id/cancel', (_b, p) => ({ ok: cancelJob(p.id) }));

// ------------------------------------------------------------------ server
const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (!url.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    serveStatic(req, res);
    return;
  }
  if (url !== '/api/health' && !authorized(req)) {
    send(res, 401, { error: 'Password required' });
    return;
  }
  const r = routes.find(x => x.method === req.method && x.pattern.test(url));
  if (!r) {
    send(res, 404, { error: 'Not found' });
    return;
  }
  try {
    const m = url.match(r.pattern)!;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    // GET: the query string (?since=…) becomes the body
    const body = req.method === 'GET' ? Object.fromEntries(new URLSearchParams((req.url || '').split('?')[1] || '')) : await readBody(req);
    const out = await r.handler(body, params);
    send(res, 200, out, req);
  } catch (e: any) {
    const status = e?.status || 500;
    if (status >= 500) console.error(`[api] ${req.method} ${url}:`, e?.message);
    send(res, status, { error: String(e?.message || e) }, req);
  }
});

server.requestTimeout = 0; // research calls can take a while
server.headersTimeout = 65000;
// Render's free plan starts with an empty disk: bring the data back from Google Drive first
await restoreFromBackup();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`SafeCart Kids Investor Agent on :${PORT}`);
  startAutomation();
  resumeOnBoot();
  console.log(`  AI providers:     ${aiProviderNames().join(', ') || 'NONE — set GEMINI_API_KEY or GROQ_API_KEY'}`);
  console.log(`  Search providers: ${searchProviderNames().join(', ')}`);
  console.log(`  Email:            ${emailProvider()}`);
  console.log(`  Storage:          ${storageInfo().path}`);
  if (!PASSWORD) console.log('  WARNING: APP_PASSWORD not set — anyone with the URL can use your free AI quota.');
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    setTimeout(() => process.exit(0), 12000).unref();
    await shutdownSave().catch(() => flushNow());
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
