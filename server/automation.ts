/**
 * Automatic outreach — runs on the server every few minutes, even when nobody has the app open.
 *
 *  • Emails every investor at or above your score threshold (Settings → "Auto-email"),
 *    then follow-ups on day 4 / 10 / 21, inside a daily limit that protects your Gmail.
 *  • Stops follow-ups automatically when the investor replies (Gmail helper reads your inbox).
 *  • Marks investors as "accepted" when LinkedIn emails you "… accepted your invitation".
 *
 * Nothing here logs into LinkedIn — LinkedIn requests/messages stay one-click in the app.
 */
import { loadState, saveState, updateInvestor } from './store';
import { emailProvider, sendEmail } from './email';
import { gmailConfigured, gmailCheck, gmailQuota, isSetupError } from './gmail';
import type { AutomationStatus, Investor } from '../src/types';
import { audienceOf, AUDIENCE_TEXT } from '../src/data/audience';
import { targetGeo } from '../src/data/geo';
import { excludedReason } from '../src/data/filters';
import { TEMPLATE_V } from '../src/data/emailTemplates';
import { generateOutreach } from './agent';

/** "[Investor]" / "[Fundraising Expert]" — shown in activity and notes so you know who it is at a glance */
const tagOf = (i: Investor) => `[${AUDIENCE_TEXT[audienceOf(i)].label}]`;

const TICK_MS = () => Number(process.env.AUTOMATION_TICK_MS || 5 * 60_000);
const CHECK_EVERY_MS = () => Number(process.env.AUTOMATION_CHECK_MS || 15 * 60_000);
const MAX_PER_TICK = () => Number(process.env.AUTOMATION_MAX_PER_TICK || 5);
const CLOSED = ['replied', 'meeting', 'diligence', 'passed'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const todayUtc = () => new Date().toISOString().slice(0, 10);
const addDays = (iso: string, days: number) => {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z]/g, '');

let running = false;
let current: Promise<void> = Promise.resolve();
let lastGmailRemaining: number | undefined;

function settingsOf(st: any) {
  const s = st.settings || {};
  return {
    autoEmailEnabled: !!s.autoEmailEnabled,
    autoEmailMinScore: Number.isFinite(s.autoEmailMinScore) ? s.autoEmailMinScore : 50,
    dailyEmailLimit: Math.max(1, Math.min(1500, Number(s.dailyEmailLimit) || 25)),
    emailHoldMinutes: Math.max(0, Number(s.emailHoldMinutes ?? 60)),
    companyAddress: String(s.companyAddress || '').trim(),
    senderName: String(s.senderName || '').trim(),
    senderEmail: String(s.senderEmail || '').trim(),
    geo: targetGeo(st.startup?.location)
  };
}

/** Never emailed: law firms & other non-experts, people outside the target country (USA), people who want money upfront. */
export const excludedFromOutreach = excludedReason;

function note(level: 'info' | 'success' | 'warn' | 'error', message: string) {
  const a = loadState().automation!;
  a.recent = [...(a.recent || []), { at: new Date().toISOString(), message, level }].slice(-60);
}

function sentToday(): number {
  const t = todayUtc();
  return (loadState().automation?.sentLog || []).filter(x => x.at.startsWith(t)).length;
}

/** Which email (if any) is due for this investor right now. Returns the step index (0-based). */
export function dueStep(inv: Investor, cfg: ReturnType<typeof settingsOf>, now = Date.now()): number {
  const o = inv.outreach;
  if (!inv.email || !EMAIL_RE.test(inv.email)) return -1;
  if (o.autoPaused || CLOSED.includes(o.status)) return -1;
  if (excludedFromOutreach(inv, cfg.geo)) return -1;
  if (inv.researchDepth === 'quick') return -1; // quick-scanned only: no researched email yet
  if (!o.sequences?.length) return -1;
  if ((inv.fitScore?.total ?? 0) < cfg.autoEmailMinScore) return -1;
  const idx = o.sentStepsCount || 0;
  if (idx >= o.sequences.length) return -1;
  if (o.sequences[idx]?.sentAt) return -1;
  if (idx === 0) {
    const readyAt = Date.parse(inv.extractedData?.crawledAt || inv.createdAt) || 0;
    return now - readyAt >= cfg.emailHoldMinutes * 60_000 ? 0 : -1;
  }
  return o.nextFollowUpDate && o.nextFollowUpDate <= todayUtc() ? idx : -1;
}

function withFooter(body: string, _startupName: string, cfg: ReturnType<typeof settingsOf>, _founderName: string) {
  // the email already ends with the founder's signature — only the address + opt-out line US law asks for
  const lines = ['', '--'];
  if (cfg.companyAddress) lines.push(cfg.companyAddress);
  lines.push('If you would rather not hear from me again, just reply "no thanks".');
  return `${body.trimEnd()}\n${lines.join('\n')}`;
}

async function sendDue() {
  const st = loadState();
  const cfg = settingsOf(st);
  if (!cfg.autoEmailEnabled) return;
  if (emailProvider() === 'none') {
    note('warn', 'Auto-email is on, but no email sender is set up (add the Gmail helper script).');
    return;
  }
  let budget = Math.min(cfg.dailyEmailLimit - sentToday(), MAX_PER_TICK());
  if (budget <= 0) return;

  const due = st.investors
    .map((inv: Investor) => ({ inv, step: dueStep(inv, cfg) }))
    .filter(x => x.step >= 0)
    // follow-ups first (they're time-sensitive), then best fit first
    .sort((a, b) => (b.step > 0 ? 1 : 0) - (a.step > 0 ? 1 : 0) || (b.inv.fitScore?.total || 0) - (a.inv.fitScore?.total || 0));

  const startupName = st.startup?.name || '';
  const founderName = st.startup?.founderName || '';
  const replyTo = st.startup?.founderEmail || cfg.senderEmail || undefined;

  for (const { inv: found, step } of due) {
    if (budget <= 0) break;
    let inv = found;
    // written with an older template? rebuild the emails not sent yet from the current template before sending
    if ((inv.outreach.templateV || 1) < TEMPLATE_V) {
      try {
        const o = await generateOutreach(st.startup, inv, st.settings);
        if (o.sequences.length) {
          updateInvestor(inv.id, i => ({
            ...i,
            linkedinNote: o.linkedinNote || i.linkedinNote,
            linkedinMessage: o.linkedinMessage || i.linkedinMessage,
            outreach: {
              ...i.outreach,
              // keep emails already sent exactly as they were; replace the rest
              sequences: o.sequences.map((ns, k) => (i.outreach.sequences[k]?.sentAt ? i.outreach.sequences[k] : ns)),
              sequenceGenerated: true,
              templateV: o.templateV
            }
          }));
          inv = loadState().investors.find((x: Investor) => x.id === inv.id) || inv;
          note('info', `${tagOf(inv)} Rebuilt the emails for ${inv.name} from the new template before sending.`);
        }
      } catch (e: any) {
        note('warn', `${tagOf(inv)} Could not rewrite the emails for ${inv.name} yet (${String(e?.message || e).slice(0, 80)}) — will try again later.`);
        continue;
      }
    }
    const seq = inv.outreach.sequences[step];
    const res = await sendEmail(
      inv.email,
      seq.subject,
      withFooter(seq.body, startupName, cfg, founderName),
      replyTo,
      cfg.senderName || founderName || undefined,
      AUDIENCE_TEXT[audienceOf(inv)].label
    );
    if (!res.ok) {
      const err = res.error || 'send failed';
      updateInvestor(inv.id, i => ({ ...i, outreach: { ...i.outreach, autoError: err } }));
      note('error', `${tagOf(inv)} Email to ${inv.name} failed: ${err}`);
      if (/daily|limit|quota/i.test(err)) break;
      // a set-up problem (wrong password, old script…) fails every email the same way — stop and say it once
      if (isSetupError(err)) {
        note('error', `Stopped sending until this is fixed: ${err}`);
        break;
      }
      continue;
    }
    budget--;
    const today = todayUtc();
    const next = inv.outreach.sequences[step + 1];
    const nextDate = next ? addDays(today, Math.max(1, (next.dayDelay ?? 0) - (seq.dayDelay ?? 0))) : '';
    updateInvestor(inv.id, i => ({
      ...i,
      outreach: {
        ...i.outreach,
        sequences: i.outreach.sequences.map((s: any, k: number) => (k === step ? { ...s, sentAt: new Date().toISOString() } : s)),
        status: CLOSED.includes(i.outreach.status) ? i.outreach.status : 'contacted',
        sentStepsCount: Math.max(i.outreach.sentStepsCount || 0, step + 1),
        lastContactedDate: today,
        nextFollowUpDate: nextDate,
        autoError: undefined
      }
    }));
    const a = loadState().automation!;
    a.sentLog = [...(a.sentLog || []), { at: new Date().toISOString(), investorId: inv.id, step: step + 1 }].slice(-3000);
    note('success', `${tagOf(inv)} Sent email ${step + 1} to ${inv.name}${inv.firm ? ` (${inv.firm})` : ''}${next ? ` — next follow-up ${nextDate}` : ' — sequence complete'}`);
    await new Promise(r => setTimeout(r, 4000)); // space out sends
  }
}

async function checkInbox(force = false) {
  if (!gmailConfigured()) return;
  const st = loadState();
  const a = st.automation!;
  if (!force && a.lastCheckAt && Date.now() - Date.parse(a.lastCheckAt) < CHECK_EVERY_MS()) return;
  a.lastCheckAt = new Date().toISOString();

  const watching = st.investors.filter(
    (i: Investor) => i.email && EMAIL_RE.test(i.email) && (i.outreach.sentStepsCount > 0 || i.outreach.status === 'contacted') && !CLOSED.includes(i.outreach.status)
  );
  const list = watching.slice(0, 400);
  const tags: Record<string, string> = {};
  for (const i of list) tags[i.email.toLowerCase()] = AUDIENCE_TEXT[audienceOf(i)].label;
  const res = await gmailCheck(list.map((i: Investor) => i.email.toLowerCase()), 60, tags);
  lastGmailRemaining = res.remaining;

  for (const r of res.replies) {
    const inv = watching.find((i: Investor) => i.email.toLowerCase() === r.email);
    if (!inv) continue;
    const lastSent = Date.parse(inv.outreach.lastContactedDate || '') || 0;
    if (Date.parse(r.date) < lastSent - 86_400_000) continue; // older than our outreach
    updateInvestor(inv.id, i => ({
      ...i,
      outreach: {
        ...i.outreach,
        status: 'replied',
        replyDate: r.date.slice(0, 10),
        nextFollowUpDate: '',
        responseNotes: `${i.outreach.responseNotes ? i.outreach.responseNotes + '\n' : ''}${tagOf(i)} Reply (${r.date.slice(0, 10)}): ${r.snippet}`.slice(0, 2000)
      }
    }));
    note('success', `${tagOf(inv)} ${inv.name} replied — follow-ups stopped. Check your Gmail (tagged "${AUDIENCE_TEXT[audienceOf(inv)].label}").`);
  }

  for (const acc of res.accepted) {
    const key = norm(acc.name);
    if (!key) continue;
    const inv = loadState().investors.find(
      (i: Investor) => !i.outreach.linkedinAcceptedAt && (norm(i.name) === key || (key.length > 6 && norm(i.name).startsWith(key)))
    );
    if (!inv) continue;
    updateInvestor(inv.id, i => ({ ...i, outreach: { ...i.outreach, linkedinAcceptedAt: acc.date } }));
    note('success', `${tagOf(inv)} ${inv.name} accepted your LinkedIn invitation — send them the message from the Outreach tab.`);
  }
}

function tick(forceCheck = false): Promise<void> {
  if (running) return current;
  current = doTick(forceCheck);
  return current;
}

/**
 * Emails written before the current template are rebuilt in the background (a few per check), so the
 * Outreach tab — and anything you send by hand — always shows the current wording. Sent emails stay as they were.
 */
async function upgradeOldEmails(max = Number(process.env.TEMPLATE_UPGRADE_PER_TICK || 8)) {
  const st = loadState();
  const geo = targetGeo(st.startup?.location);
  const todo = st.investors
    .filter(
      (i: Investor) =>
        i.researchDepth !== 'quick' &&
        i.outreach?.sequences?.length &&
        (i.outreach.templateV || 1) < TEMPLATE_V &&
        !CLOSED.includes(i.outreach.status) &&
        !excludedReason(i, geo) &&
        (i.outreach.sentStepsCount || 0) < i.outreach.sequences.length
    )
    .slice(0, max);
  for (const inv of todo) {
    try {
      const o = await generateOutreach(st.startup, inv, st.settings, { requireAI: true });
      if (!o.sequences.length) continue;
      updateInvestor(inv.id, i => ({
        ...i,
        linkedinNote: o.linkedinNote || i.linkedinNote,
        linkedinMessage: o.linkedinMessage || i.linkedinMessage,
        outreach: {
          ...i.outreach,
          sequences: o.sequences.map((ns, k) => (i.outreach.sequences[k]?.sentAt ? i.outreach.sequences[k] : ns)),
          sequenceGenerated: true,
          templateV: o.templateV
        }
      }));
    } catch {
      break; // AI busy — try again next check
    }
  }
}

async function doTick(forceCheck: boolean) {
  if (running) return;
  running = true;
  const a = loadState().automation!;
  try {
    let setupProblem = '';
    await checkInbox(forceCheck).catch(e => {
      a.lastError = String(e?.message || e);
      if (isSetupError(a.lastError)) setupProblem = a.lastError;
      else note('warn', `Inbox check failed: ${a.lastError}`);
    });
    // wrong password / old script: every email would fail the same way — say it once, send nothing
    if (setupProblem) note('error', `Paused sending and reply checks until this is fixed: ${setupProblem}`);
    else await sendDue();
    await upgradeOldEmails();
    a.lastRunAt = new Date().toISOString();
    if (!forceCheck) a.lastError = a.lastError && /Inbox check failed/.test(a.lastError) ? a.lastError : undefined;
  } catch (e: any) {
    a.lastError = String(e?.message || e);
    note('error', a.lastError);
  } finally {
    saveState({ automation: a });
    running = false;
  }
}

export function startAutomation() {
  setTimeout(() => tick(), 20_000);
  setInterval(() => tick(), TICK_MS());
}

export async function runAutomationNow() {
  if (running) await current; // a check was already running: let it finish, then run a fresh one
  await tick(true);
  return automationStatus();
}

export async function automationStatus(): Promise<AutomationStatus> {
  const st = loadState();
  const cfg = settingsOf(st);
  const a = st.automation || {};
  if (gmailConfigured() && lastGmailRemaining === undefined) lastGmailRemaining = await gmailQuota();
  return {
    emailProvider: emailProvider(),
    autoEmailEnabled: cfg.autoEmailEnabled,
    sentToday: sentToday(),
    dailyLimit: cfg.dailyEmailLimit,
    gmailRemaining: lastGmailRemaining,
    queued: st.investors.filter((i: Investor) => dueStep(i, cfg) >= 0).length,
    lastRunAt: a.lastRunAt,
    lastCheckAt: a.lastCheckAt,
    lastError: a.lastError,
    recent: [...(a.recent || [])].reverse().slice(0, 25)
  };
}
