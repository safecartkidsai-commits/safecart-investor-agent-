/**
 * SafeCart Kids Investor Agent — Gmail helper (free, runs inside YOUR Google account)
 *
 * What it does for the agent:
 *   • sends investor emails FROM your own Gmail (they appear in your Sent folder)
 *   • finds investor replies in your inbox (so follow-ups stop automatically)
 *   • finds LinkedIn "… accepted your invitation" emails (so the app knows who accepted)
 *   • tags every investor / expert email thread with a Gmail label ("Investor" or "Fundraising Expert"),
 *     so you can tell them apart in your inbox — replies stay in the same tagged thread
 *   • creates a Google Sheet of your list in your Google Drive ("Open in Google Sheets" button)
 *   • keeps a backup of the agent's data (your lists) in Google Drive, folder "SafeCart Agent Data",
 *     so hosts that wipe their disk on restart (like Render's free plan) never lose your lists
 *
 * Setup (5 minutes) — see README "Automatic email (Gmail script)":
 *   1. Go to https://script.google.com → New project → paste this whole file.
 *   2. Change SECRET below to a long random password (same value as GMAIL_SCRIPT_SECRET on Railway).
 *   3. Deploy → New deployment → type "Web app" → Execute as: Me → Who has access: Anyone → Deploy.
 *   4. Allow the Gmail permissions, copy the Web app URL into Railway as GMAIL_SCRIPT_URL.
 *
 * UPDATING an older copy: paste this whole file again, put your SECRET back, Save, run "doGet" once (▶ Run)
 * and click Allow (Google asks again whenever the script gets a new ability), then Deploy → Manage deployments →
 * ✏ Edit → Version: New version → Deploy. The web app URL stays the same.
 *
 * Limits (set by Google): about 100 emails/day on a normal Gmail, 1,500/day on Google Workspace.
 */

const SECRET = 'CHANGE-ME-to-a-long-random-password';

const VERSION = 5;

/** Open the Web app URL in a browser to check what is live: version + how many characters the password has. */
function doGet() {
  const set = !!SECRET && SECRET.indexOf('CHANGE-ME') !== 0;
  return json_({
    ok: true,
    service: 'SafeCart Kids Gmail helper',
    version: VERSION,
    passwordSet: set,
    passwordLength: set ? String(SECRET).trim().length : 0,
    remaining: MailApp.getRemainingDailyQuota()
  });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!SECRET || SECRET.indexOf('CHANGE-ME') === 0) return json_({ ok: false, error: 'Set SECRET in the script first.' });
    if (String(req.secret || '').trim() !== String(SECRET).trim()) return json_({ ok: false, error: 'Wrong secret' });
    if (req.action === 'send') return json_(send_(req));
    if (req.action === 'check') return json_(check_(req));
    if (req.action === 'quota') return json_({ ok: true, remaining: MailApp.getRemainingDailyQuota(), version: VERSION });
    if (req.action === 'sheet') return json_(sheet_(req));
    if (req.action === 'saveData') return json_(saveData_(req));
    if (req.action === 'loadData') return json_(loadData_(req));
    return json_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function send_(req) {
  if (!req.to || !req.subject || !req.body) return { ok: false, error: 'to, subject and body are required' };
  if (MailApp.getRemainingDailyQuota() < 1) return { ok: false, error: 'Gmail daily sending limit reached' };
  const opts = {};
  if (req.fromName) opts.name = req.fromName;
  if (req.replyTo) opts.replyTo = req.replyTo;
  const message = GmailApp.createDraft(req.to, req.subject, req.body, opts).send();
  if (req.label) {
    try {
      message.getThread().addLabel(label_(req.label));
    } catch (err) {
      /* the email is sent; a missing label is not worth failing for */
    }
  }
  return {
    ok: true,
    messageId: message.getId(),
    threadId: message.getThread().getId(),
    remaining: MailApp.getRemainingDailyQuota()
  };
}

function check_(req) {
  const days = Math.max(1, Math.min(180, Number(req.days) || 60));
  const emails = (req.emails || []).map(function (x) { return String(x).toLowerCase().trim(); }).filter(String);
  const tags = req.tags || {}; // email -> Gmail label name ("Investor" / "Fundraising Expert")
  const replies = [];
  for (let i = 0; i < emails.length; i += 20) {
    const chunk = emails.slice(i, i + 20);
    const q = 'in:inbox newer_than:' + days + 'd from:(' + chunk.join(' OR ') + ')';
    GmailApp.search(q, 0, 100).forEach(function (thread) {
      thread.getMessages().forEach(function (m) {
        const raw = m.getFrom();
        const match = raw.match(/<([^>]+)>/);
        const from = (match ? match[1] : raw).toLowerCase().trim();
        if (chunk.indexOf(from) !== -1) {
          if (tags[from]) {
            try {
              thread.addLabel(label_(tags[from]));
            } catch (err) {
              /* ignore */
            }
          }
          replies.push({ email: from, date: m.getDate().toISOString(), subject: m.getSubject(), snippet: m.getPlainBody().slice(0, 300) });
        }
      });
    });
  }
  const accepted = [];
  GmailApp.search('newer_than:' + days + 'd subject:"accepted your invitation"', 0, 200).forEach(function (thread) {
    const m = thread.getMessages()[0];
    const s = m.getSubject();
    const found = s.match(/(?:^|,\s*)([^,]+?)\s+(?:has\s+)?accepted your invitation/i);
    if (found) accepted.push({ name: found[1].trim(), date: m.getDate().toISOString() });
  });
  return { ok: true, replies: replies, accepted: accepted, remaining: MailApp.getRemainingDailyQuota() };
}

function label_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

/** Creates ONE Google Sheet in your Drive — one tab per list (Investors, Fundraising Experts) — and returns its link. */
function sheet_(req) {
  const tabs = (req.tabs && req.tabs.length) ? req.tabs : [{ name: req.tab || 'List', headers: req.headers || [], rows: req.rows || [] }];
  if (!tabs.some(function (t) { return t.headers && t.headers.length; })) return { ok: false, error: 'Nothing to export' };
  const ss = SpreadsheetApp.create(String(req.title || 'SafeCart Kids list'));
  let total = 0;
  tabs.forEach(function (t, k) {
    const headers = t.headers || [];
    if (!headers.length) return;
    const rows = t.rows || [];
    const sh = k === 0 ? ss.getSheets()[0] : ss.insertSheet();
    sh.setName(String(t.name || ('List ' + (k + 1))).slice(0, 90));
    const data = [headers].concat(rows.map(function (r) {
      return headers.map(function (_h, i) { return r[i] == null ? '' : String(r[i]).slice(0, 49000); });
    }));
    sh.getRange(1, 1, data.length, headers.length).setValues(data);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#e8f5ee').setWrap(true);
    // long text stays on one line (click a cell to read it all)
    if (data.length > 1) sh.getRange(2, 1, data.length - 1, headers.length).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP).setVerticalAlignment('top');
    sh.setFrozenRows(1);
    sh.setFrozenColumns(Math.min(2, headers.length));
    sh.setColumnWidths(1, headers.length, 160);
    sh.getRange(1, 1, data.length, headers.length).createFilter();
    total += rows.length;
  });
  return { ok: true, url: ss.getUrl(), id: ss.getId(), rows: total, tabs: tabs.length };
}

// ---------------------------------------------------------------- data backup (Google Drive)
function dataFolder_() {
  const it = DriveApp.getFoldersByName('SafeCart Agent Data');
  return it.hasNext() ? it.next() : DriveApp.createFolder('SafeCart Agent Data');
}

function safeName_(name) {
  return String(name || 'crm.json').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
}

/** Saves the agent's data file; also keeps one copy per day for the last 7 days. */
function saveData_(req) {
  if (typeof req.content !== 'string' || !req.content) return { ok: false, error: 'Nothing to save' };
  if (req.encoding === 'gzip-base64') {
    // the agent sends the backup compressed (smaller upload); store it as plain JSON
    req.content = Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(req.content), 'application/x-gzip')).getDataAsString();
    try { JSON.parse(req.content); } catch (err) { return { ok: false, error: 'Backup arrived damaged' }; }
  }
  const folder = dataFolder_();
  const name = safeName_(req.name);
  const it = folder.getFilesByName(name);
  if (it.hasNext()) it.next().setContent(req.content);
  else folder.createFile(name, req.content, 'application/json');

  const day = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
  const daily = name.replace(/\.json$/, '') + '-' + day + '.json';
  const d = folder.getFilesByName(daily);
  if (d.hasNext()) d.next().setContent(req.content);
  else folder.createFile(daily, req.content, 'application/json');
  // remove daily copies older than 7 days
  const files = folder.getFiles();
  const cutoff = Date.now() - 8 * 86400000;
  while (files.hasNext()) {
    const f = files.next();
    if (/-\d{4}-\d{2}-\d{2}\.json$/.test(f.getName()) && f.getDateCreated().getTime() < cutoff) f.setTrashed(true);
  }
  return { ok: true, bytes: req.content.length };
}

function loadData_(req) {
  const it = dataFolder_().getFilesByName(safeName_(req.name));
  if (!it.hasNext()) return { ok: true, exists: false };
  return { ok: true, exists: true, content: it.next().getBlob().getDataAsString() };
}
