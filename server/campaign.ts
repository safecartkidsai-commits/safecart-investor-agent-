/**
 * Big runs ("campaigns") — find 100-200+ investors in one go, then the NEXT 100-200 in the next run.
 *
 *   1. Plan     → new search queries (never repeats a query used by an earlier run)
 *   2. Search   → web + public LinkedIn results, page 1 and 2
 *   3. Extract  → AI picks real investors out of the results
 *   4. Quick    → AI scores 10 investors per request from the search text (cheap + fast)
 *                 every investor above your minimum is added to the CRM straight away
 *   5. Deep     → the best ones get full research + outreach (slow on free AI plans)
 *
 * Progress is saved after every step, so a restart / redeploy just continues the run.
 */
import { webSearch, SearchResult } from './search';
import {
  defaultQueries,
  extractCandidates,
  quickScoreCandidates,
  generateSearchQueries,
  candidateToQuickInvestor,
  researchCandidate,
  investorToCandidate,
  EMAIL_SEARCH_V
} from './agent';
import { loadState, saveState, mergeInvestors } from './store';
import { audienceOf, AUDIENCE_TEXT, isNotFundraisingExpert } from '../src/data/audience';
import { comboQueries } from '../src/data/queries';
import { excludedReason } from '../src/data/filters';
import { targetGeo } from '../src/data/geo';
import type { Campaign, CampaignCandidate, StartupProfile, AppSettings, PipelineExecutionLog, Investor } from '../src/types';

const PACE_MS = () => Number(process.env.AGENT_PACE_MS || 8000);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const pct = (n: number, d: number) => `${d ? Math.round((n / d) * 100) : 0}%`;
const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

let worker: Promise<void> | null = null;

function save(c: Campaign) {
  c.counts = {
    found: c.candidates.length,
    quick: c.candidates.filter(x => x.stage === 'quick' || x.stage === 'researched').length,
    researched: c.candidates.filter(x => x.stage === 'researched').length,
    skipped: c.candidates.filter(x => x.stage === 'skipped').length,
    failed: c.candidates.filter(x => x.stage === 'failed').length,
    withEmail: c.candidates.filter(x => x.stage === 'researched' && x.hasEmail).length
  };
  saveState({ campaign: c });
}

function logTo(c: Campaign) {
  return (phase: PipelineExecutionLog['phase'], message: string, level: PipelineExecutionLog['level'] = 'info', investorName?: string) => {
    c.logs.push({ id: uid('log'), timestamp: new Date().toISOString(), phase, message, level, investorName });
    if (c.logs.length > 400) c.logs.splice(0, c.logs.length - 400);
  };
}

export function getCampaign(): Campaign | null {
  const c = loadState().campaign as Campaign | null | undefined;
  if (!c) return null;
  // the list of candidates can be long — the UI only needs counts + logs
  return { ...c, candidates: [] as CampaignCandidate[], spare: undefined };
}

export function startCampaign(startup: StartupProfile, settings: AppSettings, opts: { target: number; mode: 'quick' | 'deep' }): Campaign {
  const st = loadState();
  const cur = st.campaign as Campaign | undefined;
  if (cur && cur.status === 'running' && worker) return cur;
  // people the last run found but didn't need (it stopped at its target) start this run
  const audience = audienceOf(settings);
  const leftovers = [...(cur?.candidates || []), ...(cur?.spare || [])]
    .filter(x => x.stage === 'found' && audienceOf(x) === audience)
    .map(x => ({ ...x, attempts: 0 }))
    .slice(0, 300);
  const c: Campaign & { startup?: StartupProfile; settings?: AppSettings } = {
    id: uid('run'),
    status: 'running',
    target: Math.max(5, Math.min(500, Math.round(opts.target || 100))),
    mode: opts.mode === 'quick' ? 'quick' : 'deep',
    startedAt: new Date().toISOString(),
    phase: 'queries',
    queries: [],
    queryCursor: 0,
    audience,
    candidates: leftovers,
    spare: [...(cur?.candidates || []), ...(cur?.spare || [])].filter(x => x.stage === 'found' && audienceOf(x) !== audience).slice(0, 300),
    logs: []
  };
  // snapshot of what the run works for (so later edits don't change a run halfway)
  c.startup = startup;
  c.settings = settings;
  saveState({ campaign: c, startup, settings });
  ensureWorker();
  return c;
}

/**
 * "Research the ones I already have": deep-research quick-scanned investors (best score first),
 * then re-check deep-researched ones that have no email yet with the newer email finder.
 */
export function startUpgrade(startup: StartupProfile, settings: AppSettings, count: number): { campaign: Campaign | null; available: number } {
  const st = loadState();
  const cur = st.campaign as Campaign | undefined;
  if (cur && cur.status === 'running' && worker) return { campaign: cur, available: 0 };
  const byScore = (a: Investor, b: Investor) => (b.fitScore?.total || 0) - (a.fitScore?.total || 0);
  const audience = audienceOf(settings);
  // hidden people (upfront fees, outside the USA, not real experts) are not researched again
  const geoU = targetGeo(startup.location);
  const mine = st.investors.filter((i: Investor) => audienceOf(i) === audience && !excludedReason(i, geoU));
  const quick = mine.filter((i: Investor) => i.researchDepth === 'quick' && !['passed'].includes(i.outreach?.status)).sort(byScore);
  const recheck = mine
    .filter((i: Investor) => i.researchDepth !== 'quick' && !i.email && (i.emailSearchV || 0) < EMAIL_SEARCH_V && !['replied', 'meeting', 'diligence', 'passed'].includes(i.outreach?.status))
    .sort(byScore);
  const pool = [...quick, ...recheck];
  const n = Math.max(1, Math.min(200, Math.round(count || 20)));
  const picked = pool.slice(0, n);
  if (!picked.length) return { campaign: null, available: 0 };
  const spare = [...(cur?.candidates || []), ...(cur?.spare || [])].filter(x => x.stage === 'found').slice(0, 300);
  const c: Campaign & { startup?: StartupProfile; settings?: AppSettings } = {
    id: uid('run'),
    status: 'running',
    target: picked.length,
    mode: 'upgrade',
    audience,
    startedAt: new Date().toISOString(),
    phase: 'deep',
    queries: [],
    queryCursor: 0,
    candidates: picked.map((i: Investor) => ({
      ...investorToCandidate(i),
      stage: 'quick' as const,
      quickScore: i.fitScore?.total || 0,
      investorId: i.id,
      attempts: 0,
      force: i.researchDepth !== 'quick'
    })),
    spare,
    logs: []
  };
  c.startup = startup;
  c.settings = settings;
  logTo(c)('research', `Researching ${picked.length} ${AUDIENCE_TEXT[audience].many} you already have (${picked.filter(i => i.researchDepth === 'quick').length} quick-scanned, ${picked.filter(i => i.researchDepth !== 'quick').length} email re-checks). ${pool.length - picked.length} more left after this.`, 'success');
  save(c);
  ensureWorker();
  return { campaign: c, available: pool.length };
}

export function pauseCampaign(): boolean {
  const c = loadState().campaign as Campaign | undefined;
  if (!c || c.status !== 'running') return false;
  c.status = 'paused';
  logTo(c)('system', 'Paused. Click Resume to continue from here.', 'warn');
  save(c);
  return true;
}

export function resumeCampaign(): boolean {
  const c = loadState().campaign as Campaign | undefined;
  if (!c || c.status === 'done') return false;
  c.status = 'running';
  c.error = undefined;
  logTo(c)('system', 'Resumed.', 'info');
  save(c);
  ensureWorker();
  return true;
}

/** Called when the server starts: carry on with a run that was interrupted by a restart. */
export function resumeOnBoot() {
  const c = loadState().campaign as Campaign | undefined;
  if (c && c.status === 'running') {
    logTo(c)('system', 'Server restarted — continuing the run.', 'info');
    save(c);
    ensureWorker();
  }
}

function ensureWorker() {
  if (worker) return;
  worker = runWorker()
    .catch(e => console.error('[campaign]', e))
    .finally(() => {
      worker = null;
    });
}

async function runWorker() {
  const st = loadState();
  const c = st.campaign as Campaign & { startup?: StartupProfile; settings?: AppSettings };
  if (!c) return;
  const startup = (c.startup || st.startup) as StartupProfile;
  const settings = (c.settings || st.settings || {}) as AppSettings;
  const audience = audienceOf(c);
  const T = AUDIENCE_TEXT[audience];
  settings.audience = audience; // every AI step below works for this list
  const log = logTo(c);
  const alive = () => (loadState().campaign as Campaign)?.id === c.id && c.status === 'running';

  try {
    // ---------------- 1. plan queries
    if (c.phase === 'queries') {
      const used = st.usedQueries || [];
      const usedSet = new Set(used.map(q => q.toLowerCase()));
      const base = defaultQueries(startup, settings);
      let queries = [...base.linkedin, ...base.web].filter(q => !usedSet.has(`${q}|1`.toLowerCase()));
      const want = Math.min(60, Math.max(12, Math.ceil(c.target / 4)));
      // simple role + US city searches first (reliable, no AI needed), then AI ideas for the rest
      const g = targetGeo(startup.location);
      queries.push(...comboQueries(audience, new Set([...usedSet, ...queries.map(q => `${q}|1`.toLowerCase())]), Math.max(0, Math.ceil(want * 0.7) - queries.length), g.city, g.state));
      if (queries.length < want) {
        log('search', `Planning ${want - queries.length} new searches so this run finds new ${T.many}…`);
        try {
          const more = await generateSearchQueries(startup, settings, [...used.map(u => u.split('|')[0]), ...queries], want - queries.length);
          queries.push(...more);
        } catch (e: any) {
          log('search', `Could not plan extra searches (${String(e?.message).slice(0, 120)}) — using the saved search plan.`, 'warn');
        }
      }
      // page 1 of every query, then page 2 of the LinkedIn ones (cheap way to go deeper)
      const plan = queries.map(q => `${q}|1`).filter(k => !usedSet.has(k.toLowerCase()));
      for (const q of queries.filter(q => /site:linkedin/i.test(q))) if (!usedSet.has(`${q}|2`.toLowerCase())) plan.push(`${q}|2`);
      c.queries = plan;
      c.queryCursor = 0;
      c.phase = 'search';
      log('search', `Run started — looking for ${T.menu.toLowerCase()}: target ${c.target}, ${plan.length} searches planned.`, 'success');
      save(c);
    }

    // ---------------- 2+3. search + extract (in small batches, saved as we go)
    let replans = 0;
    let zeroStreak = 0; // searches in a row that found nothing
    let searchesDone = 0;
    let searchesWithResults = 0;
    let fallbacks = 0;
    const zeroPage1 = new Set<string>();
    const g2 = targetGeo(startup.location);
    const addCombos = (n: number) => {
      const usedNow = new Set([...(loadState().usedQueries || []).map(u => u.toLowerCase()), ...c.queries.map(k => k.toLowerCase())]);
      const more = comboQueries(audience, usedNow, n, g2.city, g2.state);
      c.queries.splice(c.queryCursor, 0, ...more.map(q => `${q}|1`));
      return more.length;
    };
    while (c.phase === 'search' && alive()) {
      if (c.candidates.length >= Math.ceil(c.target * 1.3)) break;
      if (c.queryCursor >= c.queries.length) {
        if (replans >= 2) break;
        replans++;
        if (addCombos(12)) {
          log('search', `Found ${c.candidates.length} so far — added more simple searches.`, 'info');
          continue;
        }
        const used = loadState().usedQueries || [];
        try {
          const more = await generateSearchQueries(startup, settings, used.map(u => u.split('|')[0]), 15);
          if (!more.length) break;
          c.queries.push(...more.map(q => `${q}|1`));
          log('search', `Found ${c.candidates.length} so far — planned ${more.length} more searches.`, 'info');
        } catch {
          break;
        }
      }
      // page 2 of a search whose page 1 found nothing is pointless
      while (c.queryCursor < c.queries.length && /\|2$/.test(c.queries[c.queryCursor]) && zeroPage1.has(c.queries[c.queryCursor].replace(/\|2$/, ''))) c.queryCursor++;
      const batch = c.queries.slice(c.queryCursor, c.queryCursor + 4).filter(k => !(/\|2$/.test(k) && zeroPage1.has(k.replace(/\|2$/, ''))));
      const results: SearchResult[] = [];
      for (const key of batch) {
        const i = key.lastIndexOf('|');
        const q = key.slice(0, i);
        const page = Number(key.slice(i + 1)) || 1;
        const { results: r, engine, errors } = await webSearch(q, 10, page);
        const s2 = loadState();
        s2.usedQueries = [...(s2.usedQueries || []), key].slice(-3000);
        searchesDone++;
        if (r.length) {
          searchesWithResults++;
          zeroStreak = 0;
          results.push(...r);
          log('search', `${engine}: ${r.length} results — ${q}${page > 1 ? ` (page ${page})` : ''}`);
        } else {
          log('search', `No results — ${q}${errors.length ? ` (${errors.join('; ').slice(0, 120)})` : ''}`, 'warn');
          zeroStreak++;
          if (page === 1) zeroPage1.add(q);
          if (errors.some(e => /credits|quota|402|403|432/i.test(e)) && !errors.some(e => /duckduckgo: 0/.test(e))) {
            log('search', 'Search credits look used up — add another free search key or try again tomorrow.', 'warn');
          }
        }
      }
      c.queryCursor += Math.max(1, c.queries.slice(c.queryCursor, c.queryCursor + 4).length);
      // many empty searches in a row: the planned searches are too narrow — switch to simple ones
      if (searchesDone >= 24 && searchesWithResults === 0) {
        log('search', `${searchesDone} searches and not one result — stopping so no more search credits are used. Check your SERPER_API_KEY and credits at serper.dev (or add TAVILY_API_KEY), then start the run again.`, 'error');
        break;
      }
      if (zeroStreak >= 8 && fallbacks < 2) {
        fallbacks++;
        const n = addCombos(16);
        log('search', n ? `${zeroStreak} searches in a row found nothing — switching to ${n} simpler searches.` : `${zeroStreak} searches in a row found nothing. If this keeps happening, check your Serper key / credits at serper.dev.`, 'warn');
        zeroStreak = 0;
      }
      // de-duplicate result URLs inside this batch
      const seenUrl = new Set<string>();
      const uniq = results.filter(r => {
        const k = r.url.replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
        if (seenUrl.has(k)) return false;
        seenUrl.add(k);
        return true;
      });
      if (uniq.length) {
        const s3 = loadState();
        const existing = [
          ...s3.investors.map((x: any) => ({ name: x.name, firm: x.firm })),
          ...c.candidates.map(x => ({ name: x.name, firm: x.firm }))
        ];
        const found = await extractCandidates(startup, uniq, existing, log, 1, audience);
        for (const f of found) c.candidates.push({ ...f, stage: 'found', attempts: 0 });
        log('extract', `${c.candidates.length} ${T.many} found so far (target ${c.target}).`, 'success');
      }
      save(c);
      await sleep(Math.min(PACE_MS(), 4000));
    }
    if (!alive()) return;
    if (c.phase === 'search') {
      c.phase = 'quick';
      log('extract', `Search finished — ${c.candidates.length} possible ${T.many}. Quick-scoring them now…`, 'success');
      save(c);
    }

    // ---------------- 4. quick score — 10 per AI request
    let upfrontSkips = 0;
    let outsideSkips = 0;
    while (c.phase === 'quick' && alive()) {
      const added = c.candidates.filter(x => x.stage === 'quick').length;
      if (added >= c.target) {
        const spare = c.candidates.filter(x => x.stage === 'found').length;
        if (spare) log('score', `Target reached — ${spare} extra people saved for your next run.`, 'info');
        break;
      }
      const todo = c.candidates.filter(x => x.stage === 'found').slice(0, Math.min(10, c.target - added));
      if (!todo.length) break;
      try {
        const scores = await quickScoreCandidates(startup, todo, audience);
        const st4 = loadState();
        const minKeep = settings.minFitScoreToKeep ?? 40;
        const toAdd: any[] = [];
        for (const cand of todo) {
          const r = scores.get(cand.id);
          if (!r) {
            cand.attempts = (cand.attempts || 0) + 1;
            if (cand.attempts >= 2) cand.stage = 'failed';
            continue;
          }
          cand.quickScore = r.score;
          cand.quickReason = r.reason;
          if (!r.isInvestor || r.score < minKeep || r.upfront || r.outside || (audience === 'experts' && isNotFundraisingExpert(cand))) {
            cand.stage = 'skipped';
            if (r.upfront) upfrontSkips++;
            if (r.outside) outsideSkips++;
            continue;
          }
          // don't duplicate someone already in the CRM
          const dupe = st4.investors.find((x: any) => norm(x.name) === norm(cand.name) && (norm(x.firm) === norm(cand.firm) || !cand.firm));
          if (dupe) {
            cand.stage = 'skipped';
            continue;
          }
          const inv = candidateToQuickInvestor({ ...cand, audience }, r.score, r.reason, c.id);
          cand.investorId = inv.id;
          cand.stage = 'quick';
          toAdd.push(inv);
        }
        if (toAdd.length) mergeInvestors(toAdd);
        if (upfrontSkips || outsideSkips) {
          log('score', `Filtered out ${[upfrontSkips ? `${upfrontSkips} asking for money upfront` : '', outsideSkips ? `${outsideSkips} outside the target country` : ''].filter(Boolean).join(' and ')}.`, 'info');
          upfrontSkips = 0;
          outsideSkips = 0;
        }
        log('score', `Quick-scored ${todo.length}: ${toAdd.length} added to your list (${c.candidates.filter(x => x.stage === 'quick').length} total this run).`, 'success');
      } catch (e: any) {
        const msg = String(e?.message || e);
        if (/No AI key/i.test(msg)) throw e;
        for (const cand of todo) {
          cand.attempts = (cand.attempts || 0) + 1;
          if (cand.attempts >= 3) cand.stage = 'failed';
        }
        log('score', `AI busy (free limit) — will retry: ${msg.slice(0, 120)}`, 'warn');
        await sleep(30000);
      }
      save(c);
      await sleep(PACE_MS());
    }
    if (!alive()) return;
    if (c.phase === 'quick') {
      c.phase = c.mode === 'deep' ? 'deep' : 'done';
      for (const cand of c.candidates) if (cand.stage === 'quick') cand.attempts = 0;
      save(c);
    }

    // ---------------- 5. deep research for the best ones
    if (c.phase === 'deep') {
      const upgrade = c.mode === 'upgrade';
      const minDeep = upgrade ? 0 : settings.deepResearchMinScore ?? 50;
      const limit = upgrade ? c.target : Math.max(1, settings.deepResearchPerRun ?? 40);
      // Deep research slots go first to people we can actually email: a firm website, or an email already seen.
      const priority = (x: CampaignCandidate) =>
        (x.quickScore || 0) +
        (/@[a-z0-9-]+\.[a-z]{2,}/i.test(`${x.snippet} ${x.sourceTitle}`) ? 25 : 0) +
        (x.websiteUrl ? 10 : 0) -
        (!x.websiteUrl && /linkedin\.com\/in/i.test(x.sourceUrl || x.linkedinUrl || '') ? 10 : 0);
      const queue = c.candidates
        .filter(x => x.stage === 'quick' && (x.quickScore || 0) >= minDeep)
        .sort((a, b) => priority(b) - priority(a))
        .slice(0, limit);
      if (queue.length && !upgrade) log('research', `Deep research for the top ${queue.length} (score ${minDeep}+). This is the slow part on free AI plans — leave it running.`);
      for (let pass = 0; pass < 2 && alive(); pass++) {
        for (const cand of queue) {
          if (!alive()) return;
          if (cand.stage !== 'quick') continue;
          const st5 = loadState();
          const existing = st5.investors.find((x: any) => x.id === cand.investorId);
          if (cand.investorId && !existing) {
            cand.stage = 'skipped'; // user deleted it
            continue;
          }
          if (existing?.researchDepth === 'deep' && !cand.force) {
            cand.stage = 'researched';
            continue;
          }
          log('research', `Researching ${cand.name}${cand.firm && !/independent/i.test(cand.firm) ? ` (${cand.firm})` : ''}…`, 'info', cand.name);
          try {
            const inv = await researchCandidate(startup, { ...cand, audience }, settings, log);
            if (existing) {
              inv.id = existing.id;
              inv.createdAt = existing.createdAt;
              // keep anything the user already did with this investor
              inv.outreach = { ...inv.outreach, ...keepProgress(existing.outreach) };
            }
            inv.quickScore = cand.quickScore;
            inv.campaignId = c.id;
            inv.updatedAt = new Date().toISOString();
            mergeInvestors([inv]);
            cand.investorId = inv.id;
            cand.stage = 'researched';
            cand.hasEmail = !!inv.email;
            log(
              'score',
              excludedReason(inv, g2)
                ? `Hidden from your list (not deleted): ${excludedReason(inv, g2)}${inv.upfrontFee === 'yes' && inv.feeModel ? ` (${inv.feeModel})` : ''}`
                : `Fit ${inv.fitScore.total}/100 (${inv.fitScore.status.toUpperCase()})${inv.email ? ' · email found' : ''}${inv.phone ? ' · phone found' : ''}`,
              excludedReason(inv, g2) ? 'warn' : 'success',
              cand.name
            );
            (cand as any).hasPhone = !!inv.phone;
          } catch (e: any) {
            const msg = String(e?.message || e);
            if (/No AI key/i.test(msg)) throw e;
            cand.attempts = (cand.attempts || 0) + 1;
            if (pass === 1) cand.stage = 'failed';
            log('research', pass === 0 ? 'AI busy — will retry at the end' : `Failed: ${msg.slice(0, 140)}`, pass === 0 ? 'warn' : 'error', cand.name);
          }
          save(c);
          await sleep(PACE_MS());
        }
        if (pass === 0 && queue.some(x => x.stage === 'quick') && alive()) {
          log('research', 'Waiting 60 seconds before retrying the ones that hit the free AI limit…');
          await sleep(Number(process.env.AGENT_RETRY_WAIT_MS || 60000));
        }
      }
      c.phase = 'done';
    }

    if (alive()) {
      c.phase = 'done';
      c.status = 'done';
      c.finishedAt = new Date().toISOString();
      const k = c.counts || ({} as any);
      if (c.mode === 'upgrade') {
        const done = c.candidates.filter(x => x.stage === 'researched');
        log('crm', `Finished — researched ${done.length}; ${done.filter(x => x.hasEmail).length} now have an email. The rest: use LinkedIn or their website's contact form.`, 'success');
      } else if (c.candidates.some(x => x.stage === 'researched')) {
        const done = c.candidates.filter(x => x.stage === 'researched');
        log('crm', `Public contact info for ${done.length} deep-researched ${T.many}: email ${pct(done.filter(x => x.hasEmail).length, done.length)}, phone ${pct(done.filter(x => (x as any).hasPhone).length, done.length)}. The rest: LinkedIn or their website's contact form.`, 'info');
      }
      if (c.mode !== 'upgrade') log('crm', `Run finished — ${c.candidates.filter(x => x.stage === 'quick' || x.stage === 'researched').length} ${T.many} added (${c.candidates.filter(x => x.stage === 'researched').length} deeply researched). Start another run to find the next batch.`, 'success');
      save(c);
      void k;
    }
  } catch (e: any) {
    c.status = 'error';
    c.error = String(e?.message || e);
    log('system', `Run stopped: ${c.error}`, 'error');
    save(c);
  }
}

function keepProgress(o: any) {
  if (!o) return {};
  const contacted = ['contacted', 'replied', 'meeting', 'diligence', 'passed'].includes(o.status);
  const keep: any = {};
  for (const k of ['linkedinRequestSentAt', 'linkedinAcceptedAt', 'linkedinMessagedAt', 'autoPaused', 'responseNotes', 'replyDate']) if (o[k]) keep[k] = o[k];
  if (contacted) Object.assign(keep, { status: o.status, sentStepsCount: o.sentStepsCount, lastContactedDate: o.lastContactedDate, nextFollowUpDate: o.nextFollowUpDate });
  return keep;
}
