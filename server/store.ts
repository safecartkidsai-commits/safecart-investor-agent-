import crypto from 'node:crypto';
/**
 * Tiny JSON-file database (the real "CRM" storage).
 * Set DATA_DIR to a Railway Volume mount path (e.g. /data) so data survives redeploys.
 * No database server, no install, $0.
 *
 * Both the browser AND the server (big runs, automatic emails) change investors,
 * so saves are merged per investor using `updatedAt` — nobody overwrites anybody.
 */
import fs from 'node:fs';
import path from 'node:path';
import { gmailConfigured, driveSave, driveLoad } from './gmail';

export interface StoredState {
  startup: any | null;
  investors: any[];
  settings: any | null;
  /** The current / last big run (see campaign.ts). */
  campaign?: any | null;
  /** Search queries already used (query|page) so the next run finds NEW investors. */
  usedQueries?: string[];
  /** Automatic email + LinkedIn bookkeeping (see automation.ts). */
  automation?: {
    sentLog?: { at: string; investorId: string; step: number }[];
    lastRunAt?: string;
    lastCheckAt?: string;
    lastError?: string;
    recent?: { at: string; message: string; level: 'info' | 'success' | 'warn' | 'error' }[];
  };
  /** Ids the user deleted — stops background jobs from bringing them back. */
  deletedIds?: string[];
  updatedAt: string;
}

const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.resolve(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'crm.json');

let cache: StoredState | null = null;
let writeTimer: NodeJS.Timeout | null = null;

// ---------------------------------------------------------------- Google Drive backup
// Hosts like Render's free plan wipe the disk on every restart. With the backup on, the data file is
// copied to your Google Drive (folder "SafeCart Agent Data", via the Gmail helper script) a minute after
// changes and on shutdown, and copied back when the server starts with an empty disk.
// On automatically on Render; anywhere else set DRIVE_BACKUP=1.
const BACKUP_NAME = 'crm.json';
const BACKUP_EVERY_MS = () => Number(process.env.DRIVE_BACKUP_EVERY_MS || 600_000); // at most every 10 minutes
let lastBackupHash = ''; // skip the upload when nothing changed (saves bandwidth on free hosts)
let backupTimer: NodeJS.Timeout | null = null;
let backupBlocked = false; // true while we could not read the existing backup — never overwrite it with less data
let lastBackupAt = '';
let lastBackupError = '';

export function backupEnabled(): boolean {
  const want = process.env.DRIVE_BACKUP ? /^(1|true|yes|on)$/i.test(process.env.DRIVE_BACKUP) : Boolean(process.env.RENDER);
  return want && gmailConfigured();
}

export function storageInfo() {
  const drive = backupEnabled();
  return {
    path: drive
      ? `Google Drive backup (folder "SafeCart Agent Data")${lastBackupAt ? ` · last saved ${lastBackupAt.slice(11, 16)} UTC` : ''}${backupBlocked ? ' · WAITING to read the backup' : ''}${lastBackupError ? ` · last error: ${lastBackupError.slice(0, 80)}` : ''}`
      : FILE,
    persistent: drive
      ? !backupBlocked
      : Boolean(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH) || !(process.env.RAILWAY_ENVIRONMENT || process.env.RENDER)
  };
}

function hasData(st: StoredState | null) {
  return !!st && (st.investors?.length > 0 || !!st.startup || !!st.settings);
}

/** Merge a backup into what is in memory (used if the backup could only be read after the app started). */
function mergeBackup(b: StoredState) {
  const st = loadState();
  for (const k of ['startup', 'settings', 'campaign', 'automation'] as const) if (!(st as any)[k] || (k === 'automation' && !Object.keys(st.automation || {}).length)) (st as any)[k] = (b as any)[k];
  st.usedQueries = [...new Set([...(b.usedQueries || []), ...(st.usedQueries || [])])].slice(-3000);
  st.deletedIds = [...new Set([...(b.deletedIds || []), ...(st.deletedIds || [])])].slice(-5000);
  mergeInvestors(b.investors || []);
}

async function readBackup(): Promise<'restored' | 'none' | 'kept-local'> {
  const r = await driveLoad(BACKUP_NAME);
  if (!r.exists || !r.content) return 'none';
  const b = JSON.parse(r.content) as StoredState;
  if (!Array.isArray(b.investors)) b.investors = [];
  const local = loadState();
  if (!hasData(local)) {
    cache = b;
    loadState(); // fill defaults
    flush();
    return 'restored';
  }
  // the disk survived (or the app already started): keep both, newest wins per investor
  mergeBackup(b);
  lastBackupHash = contentHash(b);
  return 'kept-local';
}

/** Call once before the server starts. Copies the Drive backup back if the disk is empty. */
export async function restoreFromBackup(): Promise<void> {
  if (!backupEnabled()) return;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await readBackup();
      console.log(`[store] Google Drive backup: ${r === 'restored' ? `restored ${loadState().investors.length} contacts` : r === 'none' ? 'none yet — a new one will be made' : 'merged with the data on disk'}`);
      backupBlocked = false;
      return;
    } catch (e: any) {
      lastBackupError = String(e?.message || e);
      console.error(`[store] could not read the Google Drive backup (try ${attempt}/3): ${lastBackupError}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 5000));
    }
  }
  // keep going, but never overwrite a backup we could not read; retry in the background
  backupBlocked = true;
  const retry = setInterval(async () => {
    try {
      await readBackup();
      backupBlocked = false;
      lastBackupError = '';
      clearInterval(retry);
      console.log('[store] Google Drive backup read — backups are on again.');
      scheduleBackup();
    } catch (e: any) {
      lastBackupError = String(e?.message || e);
    }
  }, 120_000);
  retry.unref();
}

/** Fingerprint of the data, ignoring timestamps that change on every automation check. */
function contentHash(st: StoredState): string {
  const auto = { ...(st.automation || {}) } as any;
  delete auto.lastRunAt;
  delete auto.lastCheckAt;
  const { updatedAt: _u, ...rest } = st as any;
  return crypto.createHash('sha1').update(JSON.stringify({ ...rest, automation: auto })).digest('hex');
}

async function backupNow(): Promise<void> {
  if (!backupEnabled() || backupBlocked || !cache) return;
  if (backupTimer) {
    clearTimeout(backupTimer);
    backupTimer = null;
  }
  try {
    const body = JSON.stringify(cache);
    const hash = contentHash(cache);
    if (hash === lastBackupHash) return; // nothing new since the last backup
    await driveSave(BACKUP_NAME, body);
    lastBackupHash = hash;
    lastBackupAt = new Date().toISOString();
    lastBackupError = '';
  } catch (e: any) {
    lastBackupError = String(e?.message || e);
    console.error('[store] Google Drive backup failed:', lastBackupError);
    scheduleBackup(); // try again later
  }
}

function scheduleBackup() {
  if (!backupEnabled() || backupBlocked || backupTimer) return;
  backupTimer = setTimeout(() => {
    backupTimer = null;
    void backupNow();
  }, BACKUP_EVERY_MS());
  backupTimer.unref?.();
}

/** On shutdown: write the file and send a last backup (Render gives the app a few seconds). */
export async function shutdownSave(): Promise<void> {
  flushNow();
  if (backupEnabled() && (backupTimer || !lastBackupAt)) await Promise.race([backupNow(), new Promise(r => setTimeout(r, 8000))]);
}

export function loadState(): StoredState {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    cache = { startup: null, investors: [], settings: null, updatedAt: '' };
  }
  if (!Array.isArray(cache!.investors)) cache!.investors = [];
  if (!Array.isArray(cache!.usedQueries)) cache!.usedQueries = [];
  if (!Array.isArray(cache!.deletedIds)) cache!.deletedIds = [];
  if (!cache!.automation) cache!.automation = {};
  return cache!;
}

function flush() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, FILE);
  } catch (e: any) {
    console.error('[store] write failed:', e?.message);
  }
  scheduleBackup();
}

function scheduleFlush() {
  cache!.updatedAt = new Date().toISOString();
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, 300);
}

const time = (x: any) => Date.parse(x?.updatedAt || x?.createdAt || '') || 0;

/** Merge a list of investors into the database, keeping the newer copy of each one. */
export function mergeInvestors(incoming: any[], deletedIds: string[] = []): void {
  const st = loadState();
  if (deletedIds.length) {
    const del = new Set(deletedIds);
    st.investors = st.investors.filter(i => !del.has(i.id));
    st.deletedIds = [...new Set([...(st.deletedIds || []), ...deletedIds])].slice(-5000);
  }
  const deleted = new Set(st.deletedIds || []);
  const byId = new Map(st.investors.map(i => [i.id, i]));
  for (const inv of incoming || []) {
    if (!inv?.id || deleted.has(inv.id)) continue;
    const cur = byId.get(inv.id);
    if (!cur || time(inv) >= time(cur)) byId.set(inv.id, inv);
  }
  // keep newest first
  st.investors = [...byId.values()].sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  scheduleFlush();
}

/** Server-side change to one investor (automation / research). */
export function updateInvestor(id: string, fn: (inv: any) => any): any | null {
  const st = loadState();
  const idx = st.investors.findIndex(i => i.id === id);
  if (idx === -1) return null;
  const next = { ...fn(st.investors[idx]), updatedAt: new Date().toISOString() };
  st.investors[idx] = next;
  scheduleFlush();
  return next;
}

/** Remove everything (Clear CRM). */
export function clearInvestors(): void {
  const st = loadState();
  st.deletedIds = [...new Set([...(st.deletedIds || []), ...st.investors.map(i => i.id)])].slice(-5000);
  st.investors = [];
  scheduleFlush();
}

export function saveState(patch: Partial<StoredState>): StoredState {
  const cur = loadState();
  for (const k of Object.keys(patch) as (keyof StoredState)[]) {
    if (patch[k] !== undefined && k !== 'investors') (cur as any)[k] = patch[k];
  }
  if (patch.investors !== undefined) cur.investors = patch.investors;
  scheduleFlush();
  return cur;
}

export function flushNow() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (cache) flush();
}
