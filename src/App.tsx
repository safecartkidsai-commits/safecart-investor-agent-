import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Header, TabId } from './components/Header';
import { ArchitectureModal } from './components/ArchitectureModal';
import { AutonomousRunnerModal } from './components/AutonomousRunnerModal';
import { SettingsModal } from './components/SettingsModal';
import { InvestorDetailModal } from './components/InvestorDetailModal';
import { ProductBrainTab } from './components/ProductBrainTab';
import { DiscoveryTab } from './components/DiscoveryTab';
import { TwentyCrmTab } from './components/TwentyCrmTab';
import { AiScoringTab } from './components/AiScoringTab';
import { MauticCampaignsTab } from './components/MauticCampaignsTab';
import { Investor, StartupProfile, AppSettings, OutreachStatus, HealthInfo, Audience } from './types';
import { audienceOf, textFor } from './data/audience';
import { excludedReason } from './data/filters';
import { targetGeo } from './data/geo';
import {
  loadStoredInvestors,
  saveStoredInvestors,
  loadStoredStartup,
  saveStoredStartup,
  loadStoredSettings,
  saveStoredSettings
} from './services/crmStorage';
import { api, setPassword, getPassword } from './services/api';
import { DEFAULT_STARTUP, DEFAULT_SETTINGS } from './data/defaultStartup';
import { CheckCircle2, AlertTriangle, Lock } from 'lucide-react';

const sameInvestor = (a: Investor, b: Investor) =>
  a.id === b.id ||
  (audienceOf(a) === audienceOf(b) && sameContact(a, b));
const sameContact = (a: Investor, b: Investor) =>
  (a.name.toLowerCase() === b.name.toLowerCase() && a.firm.toLowerCase() === b.firm.toLowerCase()) ||
  (!!a.linkedin && a.linkedin === b.linkedin);

export default function App() {
  const [investors, setInvestors] = useState<Investor[]>(loadStoredInvestors);
  const [startup, setStartup] = useState<StartupProfile>(loadStoredStartup);
  const [settings, setSettings] = useState<AppSettings>(loadStoredSettings);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [serverReachable, setServerReachable] = useState<boolean | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [passwordInput, setPasswordInput] = useState(getPassword());
  const [loaded, setLoaded] = useState(false);
  const serverStamp = useRef(''); // the server's updatedAt this browser already has

  const [activeTab, setActiveTab] = useState<TabId>('brain');
  const [isArchitectureModalOpen, setIsArchitectureModalOpen] = useState(false);
  const [isRunnerModalOpen, setIsRunnerModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [selectedDetailId, setSelectedDetailId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const showToast = useCallback((msg: string, error = false) => {
    setToast({ msg, error });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), error ? 7000 : 3500);
  }, []);

  // ---------- initial load: health + server copy of the CRM
  const loadFromServer = useCallback(async () => {
    try {
      const h = await api.health();
      setHealth(h);
      setServerReachable(true);
      const state = await api.loadState();
      serverStamp.current = state.updatedAt || '';
      setNeedsPassword(false);
      if (state.investors?.length) {
        setInvestors(state.investors);
      } else if (loadStoredInvestors().length) {
        // first deploy: push the browser copy up to the server
        await api.saveState({ investors: loadStoredInvestors().map(i => ({ ...i, updatedAt: i.updatedAt || new Date().toISOString() })) });
      }
      if (state.startup) setStartup({ ...DEFAULT_STARTUP, ...state.startup });
      if (state.settings) setSettings({ ...DEFAULT_SETTINGS, ...state.settings });
    } catch (e: any) {
      if (e?.status === 401) setNeedsPassword(true);
      else setServerReachable(false);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    loadFromServer();
    const onAuth = () => setNeedsPassword(true);
    window.addEventListener('safecart-auth-required', onAuth);
    return () => window.removeEventListener('safecart-auth-required', onAuth);
  }, [loadFromServer]);

  // ---------- persist: browser cache immediately; server gets ONLY what changed here (debounced)
  // The server also changes investors (big runs, auto-emails, replies), so we merge instead of overwrite.
  const dirtyIds = useRef<Set<string>>(new Set());
  const deletedIds = useRef<Set<string>>(new Set());
  const clearAll = useRef(false);
  const lastMeta = useRef('');
  const saveTimer = useRef<number | undefined>(undefined);
  const investorsRef = useRef<Investor[]>(investors);
  investorsRef.current = investors;
  const touch = (...ids: string[]) => ids.forEach(id => dirtyIds.current.add(id));

  useEffect(() => {
    if (!loaded) return;
    saveStoredInvestors(investors);
    saveStoredStartup(startup);
    saveStoredSettings(settings);
    if (needsPassword || serverReachable === false) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const meta = JSON.stringify({ startup, settings });
      const changed = investors.filter(i => dirtyIds.current.has(i.id));
      const deleted = [...deletedIds.current];
      if (!changed.length && !deleted.length && !clearAll.current && meta === lastMeta.current) return;
      const sentVersion = new Map(changed.map(i => [i.id, i.updatedAt]));
      const wasClear = clearAll.current;
      api
        .saveState({ investors: changed, deletedIds: deleted, clearAll: wasClear || undefined, startup, settings })
        .then(() => {
          // only clear ids that weren't edited again while this save was in flight
          const now = new Map(investorsRef.current.map(i => [i.id, i.updatedAt]));
          sentVersion.forEach((v, id) => {
            if (now.get(id) === v || !now.has(id)) dirtyIds.current.delete(id);
          });
          deleted.forEach(id => deletedIds.current.delete(id));
          if (wasClear) clearAll.current = false;
          lastMeta.current = meta;
        })
        .catch(() => {
          /* offline: browser copy is kept, retried on next change */
        });
    }, 800);
  }, [investors, startup, settings, loaded, needsPassword, serverReachable]);

  // ---------- pull server-side changes (new investors from big runs, auto-emails, replies, LinkedIn accepts)
  const pullServer = useCallback(async () => {
    try {
      const state = await api.loadStateSince(serverStamp.current);
      if (state.unchanged) return; // nothing new — almost every time
      let server: Investor[];
      if (state.ids) {
        // only the changed ones came back: rebuild the full list from what we already have
        const changed = new Map((state.changed || []).map(i => [i.id, i]));
        const have = new Map(investorsRef.current.map(i => [i.id, i]));
        server = [];
        for (const id of state.ids) {
          const x = changed.get(id) || have.get(id);
          if (x) server.push(x);
          else if (!deletedIds.current.has(id)) {
            serverStamp.current = ''; // something we don't have yet — fetch everything on the next check
            return;
          }
        }
      } else server = state.investors || [];
      serverStamp.current = state.updatedAt;
      setInvestors(prev => {
        const local = new Map(prev.map(i => [i.id, i]));
        const out: Investor[] = [];
        const seen = new Set<string>();
        for (const sv of server) {
          if (deletedIds.current.has(sv.id)) continue;
          const lc = local.get(sv.id);
          const keepLocal = lc && (dirtyIds.current.has(sv.id) || (Date.parse(lc.updatedAt) || 0) > (Date.parse(sv.updatedAt) || 0));
          out.push(keepLocal ? lc! : sv);
          seen.add(sv.id);
        }
        // local investors not yet saved to the server
        for (const lc of prev) if (!seen.has(lc.id) && dirtyIds.current.has(lc.id)) out.unshift(lc);
        const same = out.length === prev.length && out.every((x, k) => x === prev[k]);
        return same ? prev : out;
      });
    } catch {
      /* ignore — next poll */
    }
  }, []);

  useEffect(() => {
    if (!loaded || needsPassword || serverReachable === false) return;
    // only while the tab is visible — a background tab costs nothing
    const t = window.setInterval(() => {
      if (!document.hidden) pullServer();
    }, 20000);
    return () => window.clearInterval(t);
  }, [loaded, needsPassword, serverReachable, pullServer]);

  // ---------- which list we're working on (dropdown at the top) — saved with the settings
  const audience: Audience = audienceOf(settings);
  const T = textFor(audience);
  // people who ask for money upfront are filtered out of every tab (the list tab can show them on request)
  const [showUpfront, setShowUpfront] = useState(false);
  // hidden: asks for money upfront, outside the USA (your business country), or not really a fundraising expert
  const geo = targetGeo(startup.location);
  const asksUpfront = (i: Investor) => !!excludedReason(i, geo);
  const inList = investors.filter(i => audienceOf(i) === audience);
  const hiddenUpfront = inList.filter(asksUpfront).length;
  // why people are hidden, e.g. { "asks for money upfront": 3, "outside the United States": 2 }
  const hiddenReasons: Record<string, number> = {};
  for (const i of inList) {
    const r = excludedReason(i, geo);
    if (r) hiddenReasons[r] = (hiddenReasons[r] || 0) + 1;
  }
  const hiddenCounts: Record<Audience, number> = {
    investors: investors.filter(i => audienceOf(i) === 'investors' && asksUpfront(i)).length,
    experts: investors.filter(i => audienceOf(i) === 'experts' && asksUpfront(i)).length
  };
  const visible = showUpfront ? inList : inList.filter(i => !asksUpfront(i));
  const audienceCounts: Record<Audience, number> = {
    investors: investors.filter(i => audienceOf(i) === 'investors' && !asksUpfront(i)).length,
    experts: investors.filter(i => audienceOf(i) === 'experts' && !asksUpfront(i)).length
  };
  const changeAudience = (a: Audience) => {
    if (a === audience) return;
    setSettings(prev => ({ ...prev, audience: a }));
    setSelectedDetailId(null);
    setShowUpfront(false);
    showToast(a === 'experts' ? 'Now working on fundraising experts' : 'Now working on investors');
  };

  // ---------- CRM mutations
  const handleUpdateInvestor = (updated: Investor, quiet = false) => {
    touch(updated.id);
    setInvestors(prev => prev.map(i => (i.id === updated.id ? { ...updated, updatedAt: new Date().toISOString() } : i)));
    if (!quiet) showToast(`Updated ${updated.name}`);
  };

  const handleAddInvestor = (added: Investor, quiet = false) => {
    const newInv: Investor = { ...added, audience: added.audience || audience };
    setInvestors(prev => {
      const existing = prev.find(i => sameInvestor(i, newInv));
      if (existing) {
        touch(existing.id);
        return prev.map(i =>
          i === existing ? { ...newInv, id: existing.id, updatedAt: new Date().toISOString(), outreach: { ...newInv.outreach, ...pickProgress(existing) } } : i
        );
      }
      touch(newInv.id);
      return [newInv, ...prev];
    });
    if (!quiet) showToast(`Added ${newInv.name}${newInv.firm && !/independent/i.test(newInv.firm) ? ` (${newInv.firm})` : ''} to your ${textFor(audienceOf(newInv)).many} list`);
  };

  const patchOutreach = (id: string, patch: Partial<Investor['outreach']>) => {
    touch(id);
    setInvestors(prev => prev.map(inv => (inv.id === id ? { ...inv, outreach: { ...inv.outreach, ...patch }, updatedAt: new Date().toISOString() } : inv)));
  };

  const handleUpdateStatus = (id: string, status: OutreachStatus) => patchOutreach(id, { status });
  const handleUpdateFollowUp = (id: string, nextFollowUpDate: string) => patchOutreach(id, { nextFollowUpDate });

  const handleDeleteInvestor = (id: string) => {
    if (!confirm(`Remove this ${T.one} from your list?`)) return;
    deletedIds.current.add(id);
    dirtyIds.current.delete(id);
    setInvestors(prev => prev.filter(inv => inv.id !== id));
    showToast(`${T.One} removed`);
  };

  // Clears only the list you're looking at (investors OR experts), never both.
  const handleClearCrm = () => {
    if (!confirm(`Delete ALL ${visible.length} ${T.many} from your list? Your ${audience === 'experts' ? 'investors' : 'fundraising experts'} are not touched. This cannot be undone (export a CSV first if you want a backup).`)) return;
    const ids = new Set(visible.map(i => i.id));
    ids.forEach(id => {
      deletedIds.current.add(id);
      dirtyIds.current.delete(id);
    });
    setInvestors(prev => prev.filter(i => !ids.has(i.id)));
    showToast(`${T.Many} list cleared`);
  };

  const handleSaveStartup = (updated: StartupProfile, msg?: string) => {
    setStartup(updated);
    if (msg !== '') showToast(msg || `Saved ${updated.name} profile`);
  };

  const handleSaveSettings = (updated: AppSettings) => {
    setSettings(updated);
    showToast('Settings saved');
  };

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPassword(passwordInput);
    setLoaded(false);
    await loadFromServer();
  };

  const hotLeadsCount = visible.filter(i => i.fitScore.status === 'hot').length;
  const today = new Date().toISOString().slice(0, 10);
  const dueCount = visible.filter(
    i => i.outreach.nextFollowUpDate && i.outreach.nextFollowUpDate <= today && !['replied', 'meeting', 'diligence', 'passed'].includes(i.outreach.status)
  ).length;
  const selectedDetailInvestor = investors.find(i => i.id === selectedDetailId) || null;
  const openDetail = (inv: Investor) => setSelectedDetailId(inv.id);

  // every tab only sees the list chosen in the dropdown
  const common = { startup, settings, investors: visible, onOpenInvestorDetail: openDetail, showToast };

  return (
    <div className="min-h-screen bg-[#f4f6fa] text-slate-900 flex flex-col font-sans">
      {toast && (
        <div
          className={`fixed bottom-4 right-4 left-4 sm:left-auto z-[60] max-w-md border px-4 py-3 rounded-xl shadow-lg text-sm flex items-start gap-2 ${
            toast.error ? 'bg-red-50 border-red-200 text-red-900' : 'bg-slate-50 border-slate-300 text-slate-900'
          }`}
        >
          {toast.error ? <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" /> : <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />}
          <span className="break-words">{toast.msg}</span>
        </div>
      )}

      {needsPassword && (
        <div className="fixed inset-0 z-[70] bg-slate-900/40 flex items-center justify-center p-4">
          <form onSubmit={submitPassword} className="bg-white border border-slate-200 rounded-2xl shadow-xl p-6 w-full max-w-sm space-y-3">
            <div className="flex items-center gap-2 text-slate-900 font-semibold">
              <Lock className="w-4 h-4 text-emerald-600" /> Enter app password
            </div>
                        <input
              type="password"
              autoFocus
              value={passwordInput}
              onChange={e => setPasswordInput(e.target.value)}
              className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 focus:outline-none focus:border-emerald-400"
            />
            <button className="w-full py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold">Unlock</button>
          </form>
        </div>
      )}

      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        startup={startup}
        health={health}
        onOpenArchitectureModal={() => setIsArchitectureModalOpen(true)}
        onOpenSettingsModal={() => setIsSettingsModalOpen(true)}
        onOpenRunnerModal={() => setIsRunnerModalOpen(true)}
        totalInvestorsCount={visible.length}
        hotLeadsCount={hotLeadsCount}
        dueCount={dueCount}
        audience={audience}
        onChangeAudience={changeAudience}
        audienceCounts={audienceCounts}
        hiddenCounts={hiddenCounts}
      />

      {serverReachable === false && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-800 text-xs px-4 py-2 text-center">
          Can't reach the server right now — showing the copy saved in this browser.
        </div>
      )}
      {health && !health.ai.configured && (
        <div className="bg-red-50 border-b border-red-200 text-red-800 text-xs px-4 py-2 text-center">
          AI isn't connected yet — add <b>GEMINI_API_KEY</b> to your settings (.env locally, Variables on Railway).
        </div>
      )}

      <main key={audience} className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex-1 w-full">
        {activeTab === 'brain' && (
          <ProductBrainTab {...common} onSaveStartup={handleSaveStartup} onOpenRunnerModal={() => setIsRunnerModalOpen(true)} goTo={setActiveTab} />
        )}
        {activeTab === 'discovery' && (
          <DiscoveryTab {...common} onAddInvestor={handleAddInvestor} onOpenRunnerModal={() => setIsRunnerModalOpen(true)} />
        )}
        {activeTab === 'scoring' && <AiScoringTab {...common} onUpdateInvestor={handleUpdateInvestor} />}
        {activeTab === 'crm' && (
          <TwentyCrmTab
            investors={visible}
            startup={startup}
            onOpenInvestorDetail={openDetail}
            onUpdateStatus={handleUpdateStatus}
            onUpdateFollowUp={handleUpdateFollowUp}
            onDeleteInvestor={handleDeleteInvestor}
            onAddInvestor={inv => handleAddInvestor(inv)}
            onClearCrm={handleClearCrm}
            audience={audience}
            showToast={showToast}
            hiddenCount={hiddenUpfront}
            hiddenReasons={hiddenReasons}
            showHidden={showUpfront}
            onToggleHidden={() => setShowUpfront(v => !v)}
          />
        )}
        {activeTab === 'outreach' && <MauticCampaignsTab {...common} health={health} onUpdateInvestor={handleUpdateInvestor} />}
      </main>

      <footer className="py-5 text-center text-xs text-slate-400">
        {startup.name} Fundraising Agent · {T.menu}
      </footer>

      <ArchitectureModal isOpen={isArchitectureModalOpen} onClose={() => setIsArchitectureModalOpen(false)} />

      <AutonomousRunnerModal
        isOpen={isRunnerModalOpen}
        onClose={() => setIsRunnerModalOpen(false)}
        startup={startup}
        settings={settings}
        existingInvestors={visible}
        onRefresh={pullServer}
        onStartupIntel={intel => handleSaveStartup({ ...startup, ...intel }, '')}
        onCompletePipeline={count => {
          showToast(`Agent finished: ${count} ${T.many} added to your list`);
          setActiveTab('crm');
        }}
      />

      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        settings={settings}
        health={health}
        onSaveSettings={handleSaveSettings}
        onClearCrm={handleClearCrm}
        onRefreshHealth={loadFromServer}
      />

      <InvestorDetailModal
        key={selectedDetailInvestor?.id || 'none'}
        isOpen={!!selectedDetailInvestor}
        onClose={() => setSelectedDetailId(null)}
        investor={selectedDetailInvestor}
        startup={startup}
        settings={settings}
        onUpdateInvestor={handleUpdateInvestor}
        showToast={showToast}
      />
    </div>
  );
}

function pickProgress(i: Investor): Partial<Investor['outreach']> {
  const o = i.outreach;
  const contacted = ['contacted', 'replied', 'meeting', 'diligence', 'passed'].includes(o.status);
  return contacted
    ? { status: o.status, sentStepsCount: o.sentStepsCount, lastContactedDate: o.lastContactedDate, nextFollowUpDate: o.nextFollowUpDate, responseNotes: o.responseNotes, replyDate: o.replyDate }
    : {};
}
