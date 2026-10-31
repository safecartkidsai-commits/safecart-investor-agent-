import zlib from 'node:zlib';
/**
 * Talks to the free Gmail helper script (google-apps-script/Code.gs) that runs in the founder's
 * own Google account. Railway's free plan blocks normal email (SMTP), but this goes over HTTPS
 * and the email is actually sent by Gmail itself — from your real address, $0.
 *
 *   GMAIL_SCRIPT_URL     the Web app URL from Apps Script (ends with /exec)
 *   GMAIL_SCRIPT_SECRET  the same SECRET you typed into the script
 */
const env = (k: string) => (process.env[k] || '').trim();
/** the password, without quotes someone may have typed around it in Railway / Render */
const secret = () => env('GMAIL_SCRIPT_SECRET').replace(/^['"]+|['"]+$/g, '').trim();

/** Problems with the set-up (not with one email): retrying other emails is pointless until it's fixed. */
export function isSetupError(msg: string): boolean {
  return /wrong secret|set secret|old version|unknown action|web page instead|not set up|not reachable|authoriz|permission/i.test(msg);
}

/** Turns the script's short errors into plain instructions. */
function explain(msg: string): string {
  if (/Wrong secret/i.test(msg))
    return 'Gmail helper: Wrong secret — GMAIL_SCRIPT_SECRET on your server is not exactly the same as the SECRET line in your Google script. Copy the same password into both (no spaces, no quotes), then Deploy → Manage deployments → Edit → New version in the script.';
  if (/Set SECRET/i.test(msg)) return 'Gmail helper: the script still has CHANGE-ME on its SECRET line — put your password there, Save, and deploy a New version.';
  return msg;
}

export function gmailConfigured(): boolean {
  return /^https:\/\/script\.google\.com\/.+\/exec$/.test(env('GMAIL_SCRIPT_URL')) && !!env('GMAIL_SCRIPT_SECRET');
}

async function call(payload: Record<string, unknown>, timeoutMs = 60000): Promise<any> {
  if (!gmailConfigured()) throw new Error('Gmail helper not set up (GMAIL_SCRIPT_URL / GMAIL_SCRIPT_SECRET).');
  const res = await fetch(env('GMAIL_SCRIPT_URL'), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...payload, secret: secret() }),
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      /<html|<!doctype/i.test(text)
        ? 'Gmail helper returned a web page instead of data — redeploy it with "Who has access: Anyone".'
        : `Gmail helper error ${res.status}`
    );
  }
  if (!data.ok) throw new Error(explain(`Gmail helper: ${data.error || 'failed'}`));
  return data;
}

export async function gmailSend(
  to: string,
  subject: string,
  body: string,
  opts: { replyTo?: string; fromName?: string; label?: string } = {}
): Promise<{ ok: boolean; threadId?: string; remaining?: number; error?: string }> {
  try {
    const r = await call({ action: 'send', to, subject, body, replyTo: opts.replyTo, fromName: opts.fromName, label: opts.label });
    return { ok: true, threadId: r.threadId, remaining: r.remaining };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export async function gmailCheck(emails: string[], days = 60, tags: Record<string, string> = {}): Promise<{
  replies: { email: string; date: string; subject: string; snippet: string }[];
  accepted: { name: string; date: string }[];
  remaining?: number;
}> {
  const r = await call({ action: 'check', emails, days, tags }, 120000);
  return { replies: r.replies || [], accepted: r.accepted || [], remaining: r.remaining };
}

export async function gmailQuota(): Promise<number | undefined> {
  try {
    return (await call({ action: 'quota' }, 20000)).remaining;
  } catch {
    return undefined;
  }
}

/** Creates a Google Sheet in the founder's Drive (needs the updated helper script). */
export interface SheetTab {
  name: string;
  headers: string[];
  rows: (string | number)[][];
}

/** Creates ONE Google Sheet in the founder's Drive with a tab per list; returns its link. */
export async function gmailSheet(title: string, tabs: SheetTab[]): Promise<{ url: string; rows: number; tabs: number }> {
  try {
    // headers/rows of the first tab are also sent so an older script still makes a (one-tab) sheet
    const r = await call({ action: 'sheet', title, tabs, tab: tabs[0]?.name, headers: tabs[0]?.headers, rows: tabs[0]?.rows }, 180000);
    return { url: r.url, rows: r.rows, tabs: r.tabs || 1 };
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/Unknown action/i.test(msg))
      throw new Error('your Gmail helper script is an old version. Paste the new google-apps-script/Code.gs on script.google.com, put your SECRET back, Save, then Deploy → Manage deployments → Edit → New version → Deploy.');
    if (/permission|authoriz|scopes|SpreadsheetApp|not have access/i.test(msg))
      throw new Error('the Gmail helper script needs permission to create Google Sheets. On script.google.com choose doGet → ▶ Run → Allow, then Deploy → Manage deployments → Edit → New version → Deploy.');
    if (/web page instead of data/i.test(msg)) throw new Error('the Gmail helper is not reachable — in its deployment, "Who has access" must be "Anyone".');
    throw new Error(msg.replace(/^Gmail helper:\s*/, ''));
  }
}

/** "Test connection" in Settings: checks the URL, the password and the script version. */
export async function gmailTest(): Promise<{ ok: boolean; message: string; version?: number }> {
  if (!gmailConfigured()) return { ok: false, message: 'GMAIL_SCRIPT_URL and/or GMAIL_SCRIPT_SECRET are missing in your server variables.' };
  try {
    const r = await call({ action: 'quota' }, 20000);
    const v = Number(r.version || 1);
    scriptVersion = v;
    if (v < 5)
      return { ok: false, version: v, message: `Connected and the password is right, but the script is an old version (v${v}). Paste the new Code.gs, put your SECRET back, Save, run doGet → Allow, then Deploy → Manage deployments → Edit → New version.` };
    return { ok: true, version: v, message: `Connected — password correct, script up to date (v${v}). Gmail can still send ${r.remaining} emails today.` };
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/Wrong secret/i.test(msg))
      return {
        ok: false,
        message: `Wrong secret. The password on this server has ${secret().length} characters. Open your GMAIL_SCRIPT_URL in a browser: it shows "passwordLength" and "version" of the LIVE script. If the version is missing or below 5, the link runs an old copy — deploy a New version (or put the newest deployment's URL in GMAIL_SCRIPT_URL). If the lengths differ, the passwords differ.`
      };
    return { ok: false, message: msg };
  }
}

/** Save / load the agent's data file in Google Drive (folder "SafeCart Agent Data"). */
let scriptVersion = 0; // learned once; v5+ accepts compressed backups

export async function driveSave(name: string, content: string): Promise<void> {
  try {
    if (!scriptVersion) {
      try {
        scriptVersion = Number((await call({ action: 'quota' }, 20000)).version || 1);
      } catch {
        scriptVersion = 0;
      }
    }
    if (scriptVersion >= 5) {
      // about 10x smaller upload: important on hosts that limit outgoing data (Render free: 5 GB a month)
      await call({ action: 'saveData', name, encoding: 'gzip-base64', content: zlib.gzipSync(content, { level: 9 }).toString('base64') }, 120000);
      return;
    }
    await call({ action: 'saveData', name, content }, 120000);
  } catch (e: any) {
    if (/Unknown action/i.test(String(e?.message))) throw new Error('Gmail helper script is an old version — paste the new Code.gs and deploy a new version.');
    throw e;
  }
}

export async function driveLoad(name: string): Promise<{ exists: boolean; content?: string }> {
  try {
    const r = await call({ action: 'loadData', name }, 120000);
    return { exists: !!r.exists, content: r.content };
  } catch (e: any) {
    if (/Unknown action/i.test(String(e?.message))) throw new Error('Gmail helper script is an old version — paste the new Code.gs and deploy a new version.');
    throw e;
  }
}
