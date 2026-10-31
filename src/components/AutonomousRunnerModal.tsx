import React, { useEffect, useRef, useState } from 'react';
import { X, Play, Pause, Loader2, Terminal, Sparkles, RotateCw } from 'lucide-react';
import { Investor, StartupProfile, AppSettings, Campaign } from '../types';
import { audienceOf, textFor } from '../data/audience';
import { api } from '../services/api';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  startup: StartupProfile;
  settings: AppSettings;
  existingInvestors: Investor[];
  onRefresh: () => void;
  onStartupIntel: (intel: Partial<StartupProfile>) => void;
  onCompletePipeline?: (newCount: number) => void;
}

const phaseClass: Record<string, string> = {
  product: 'bg-pink-50 text-pink-700',
  search: 'bg-cyan-50 text-cyan-700',
  extract: 'bg-cyan-50 text-cyan-700',
  research: 'bg-indigo-50 text-indigo-700',
  score: 'bg-amber-50 text-amber-700',
  outreach: 'bg-purple-50 text-purple-700',
  crm: 'bg-emerald-50 text-emerald-700',
  system: 'bg-slate-100 text-slate-700'
};

const PHASE_LABEL: Record<Campaign['phase'], string> = {
  queries: 'Planning searches',
  search: 'Searching the web & LinkedIn',
  extract: 'Picking out the right people',
  quick: 'Quick-scoring',
  deep: 'Deep research',
  done: 'Finished'
};

function progressOf(c: Campaign): number {
  const k = c.counts || { found: 0, quick: 0, researched: 0, skipped: 0, failed: 0 };
  if (c.status === 'done') return 100;
  if (c.mode === 'upgrade') return Math.min(99, Math.round(((k.researched + k.failed) / Math.max(1, k.found)) * 100));
  if (c.phase === 'queries') return 2;
  if (c.phase === 'search' || c.phase === 'extract') return Math.min(35, Math.round((k.found / Math.max(1, c.target * 1.3)) * 35));
  if (c.phase === 'quick') {
    const scored = k.quick + k.skipped + k.failed;
    return 35 + Math.round((scored / Math.max(1, k.found)) * 25);
  }
  if (c.phase === 'deep') return 60 + Math.min(39, Math.round((k.researched / Math.max(1, Math.min(k.quick, 40))) * 39));
  return 99;
}

export const AutonomousRunnerModal: React.FC<Props> = ({ isOpen, onClose, startup, settings, existingInvestors, onRefresh, onStartupIntel, onCompletePipeline }) => {
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [target, setTarget] = useState(settings.leadsPerRun || 100);
  const [mode, setMode] = useState<'deep' | 'quick' | 'upgrade'>('deep');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const reported = useRef<string>('');
  const cb = useRef({ onRefresh, onCompletePipeline });
  cb.current = { onRefresh, onCompletePipeline };

  useEffect(() => setTarget(settings.leadsPerRun || 100), [settings.leadsPerRun]);

  // load current run when opened
  useEffect(() => {
    if (!isOpen) return;
    api
      .getCampaign()
      .then(r => {
        setCampaign(r.campaign);
        if (r.campaign?.status === 'done') reported.current = r.campaign.id;
        setShowForm(!r.campaign || r.campaign.status === 'done' || r.campaign.status === 'error');
      })
      .catch(() => setShowForm(true));
  }, [isOpen]);

  // poll while running (even if the window is closed, the run continues on the server)
  useEffect(() => {
    if (!isOpen || !campaign || campaign.status !== 'running') return;
    let n = 0;
    const t = window.setInterval(async () => {
      try {
        const { campaign: c } = await api.getCampaign();
        setCampaign(c);
        if (++n % 4 === 0) cb.current.onRefresh();
      } catch {
        /* ignore */
      }
    }, 3000);
    return () => window.clearInterval(t);
  }, [isOpen, campaign?.id, campaign?.status]);

  useEffect(() => {
    if (!campaign) return;
    if (campaign.status === 'done' && reported.current !== campaign.id) {
      reported.current = campaign.id;
      cb.current.onRefresh();
      const k = campaign.counts;
      cb.current.onCompletePipeline?.(k ? k.quick : 0);
    }
  }, [campaign]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [campaign?.logs.length]);

  if (!isOpen) return null;

  const start = async () => {
    setError('');
    setBusy(true);
    try {
      let s = startup;
      if (!s.investorKeywords?.length) {
        const { intel } = await api.analyzeProduct(s, settings);
        s = { ...s, ...intel };
        onStartupIntel(intel);
      }
      if (mode === 'upgrade') {
        const r = await api.upgradeCampaign(s, settings, target);
        if (!r.campaign) throw new Error(`Nothing to research — every ${textFor(audienceOf(settings)).one} in your list is already fully researched.`);
        setCampaign(r.campaign);
        setShowForm(false);
        return;
      }
      const { campaign: c } = await api.startCampaign(s, { ...settings, leadsPerRun: target }, target, mode);
      setCampaign(c);
      setShowForm(false);
    } catch (e: any) {
      setError(e?.message || 'Could not start the run');
    } finally {
      setBusy(false);
    }
  };

  const pause = async () => {
    const r = await api.pauseCampaign().catch(() => null);
    if (r) setCampaign(r.campaign);
  };
  const resume = async () => {
    const r = await api.resumeCampaign().catch(() => null);
    if (r) setCampaign(r.campaign);
  };

  const running = campaign?.status === 'running';
  const k = campaign?.counts || { found: 0, quick: 0, researched: 0, skipped: 0, failed: 0 };
  const pct = campaign ? progressOf(campaign) : 0;
  const T = textFor(audienceOf(settings));
  // a run that is looking for the OTHER list (it keeps going in the background)
  const otherRun = campaign && audienceOf(campaign) !== audienceOf(settings) ? textFor(audienceOf(campaign)) : null;
  const quickCount = existingInvestors.filter(i => i.researchDepth === 'quick').length;
  const noEmailCount = existingInvestors.filter(i => i.researchDepth !== 'quick' && !i.email && (i.emailSearchV || 0) < 2).length;
  const stats: [string, number][] =
    campaign?.mode === 'upgrade'
      ? [
          ['To research', k.found],
          ['Researched', k.researched],
          ['Email found', k.withEmail || 0],
          ['Failed', k.failed]
        ]
      : [
          ['Found', k.found],
          ['Added to list', k.quick],
          ['Deep researched', k.researched],
          ['Skipped (weak)', k.skipped]
        ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/30 backdrop-blur-sm overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-2xl max-w-3xl w-full p-5 sm:p-6 text-slate-700 shadow-2xl my-8">
        <div className="flex items-center justify-between border-b border-slate-200 pb-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-700">
              <Sparkles className="w-5 h-5" />
            </div>
            <h2 className="text-base font-semibold text-slate-900">
              {showForm ? T.find : otherRun ? otherRun.find : T.find} for {startup.name}
            </h2>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-900 p-1 rounded-md hover:bg-slate-100 cursor-pointer" title="Close (the run keeps going)">
            <X className="w-5 h-5" />
          </button>
        </div>

        {showForm ? (
          <div className="my-5 space-y-4 text-sm">
            {running && otherRun && (
              <div className="text-xs rounded-lg border border-amber-200 bg-amber-50 text-amber-900 px-3 py-2">
                A run for <b>{otherRun.many}</b> is still going. Only one run at a time — pause it (Back to current run → Pause) or wait for it to finish.
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  {mode === 'upgrade' ? 'How many to research?' : `How many ${T.many} this run?`}
                </label>
                <input
                  type="number"
                  min={mode === 'upgrade' ? 1 : 10}
                  max={300}
                  value={target}
                  onChange={e => setTarget(Math.max(mode === 'upgrade' ? 1 : 10, Math.min(300, Number(e.target.value) || 10)))}
                  className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-emerald-500"
                />
                <div className="flex gap-1 mt-1.5">
                  {(mode === 'upgrade' ? [10, 20, 40, 60] : [50, 100, 150, 200]).map(n => (
                    <button
                      key={n}
                      onClick={() => setTarget(n)}
                      className={`px-2 py-0.5 rounded text-xs border cursor-pointer ${target === n ? 'bg-emerald-50 border-emerald-300 text-emerald-800' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input type="radio" className="mt-1" checked={mode === 'deep'} onChange={() => setMode('deep')} />
                  <span>
                    <span className="font-medium text-slate-900">Quick scan + deep research</span>
                    <span className="block text-xs text-slate-500">
                      Best {settings.deepResearchPerRun ?? 40} (score {settings.deepResearchMinScore ?? 50}+) get full research and emails written for {T.many}.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input type="radio" className="mt-1" checked={mode === 'quick'} onChange={() => setMode('quick')} />
                  <span>
                    <span className="font-medium text-slate-900">Quick scan only</span>
                    <span className="block text-xs text-slate-500">Fastest. Research any of them later from their profile.</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    className="mt-1"
                    checked={mode === 'upgrade'}
                    onChange={() => {
                      setMode('upgrade');
                      setTarget(20);
                    }}
                  />
                  <span>
                    <span className="font-medium text-slate-900">Research the ones I already have (find emails)</span>
                    <span className="block text-xs text-slate-500">
                      No new searching. Best scores first: {quickCount} quick-scanned{noEmailCount ? ` + ${noEmailCount} to re-check for an email` : ''}.
                    </span>
                  </span>
                </label>
              </div>
            </div>
            <p className="text-xs text-slate-500">
              {mode === 'upgrade'
                ? 'Each one takes about a minute on free AI plans. You can close this window — it keeps going on the server.'
                : <>Each run skips {T.many} already in your list and searches already used, so the next run finds new people. You have {existingInvestors.length} so far.</>}
            </p>
            <div className="flex justify-end gap-2">
              {campaign && campaign.status !== 'done' && (
                <button onClick={() => setShowForm(false)} className="px-4 py-2 rounded-lg border border-slate-300 hover:bg-slate-50 cursor-pointer">
                  Back to current run
                </button>
              )}
              <button
                onClick={start}
                disabled={busy}
                className="px-5 py-2 font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 rounded-lg flex items-center gap-1.5 cursor-pointer"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 fill-current" />}
                Start
              </button>
            </div>
          </div>
        ) : campaign ? (
          <div className="my-5 space-y-4">
            {otherRun && (
              <div className="text-xs rounded-lg border border-sky-200 bg-sky-50 text-sky-900 px-3 py-2">
                This run is looking for <b>{otherRun.many}</b>. It keeps going in the background — switch the dropdown at the top to "{otherRun.menu}" to see what it finds.
                {running ? ' Only one run at a time: pause it or let it finish before starting one for this list.' : ''}
              </div>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
              {stats.map(([l, v]) => (
                <div key={l as string} className="rounded-lg border border-slate-200 p-2.5">
                  <div className="text-xl font-semibold text-slate-900">{v as number}</div>
                  <div className="text-xs text-slate-500">{l}</div>
                </div>
              ))}
            </div>

            <div>
              <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
                <span>
                  {campaign.status === 'paused' ? 'Paused' : campaign.status === 'error' ? 'Stopped' : PHASE_LABEL[campaign.phase]} · target {campaign.target}
                </span>
                <span>{pct}%</span>
              </div>
              <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                <div className="bg-emerald-500 h-2 transition-all duration-500" style={{ width: `${pct}%` }} />
              </div>
            </div>

            <div className="flex items-center gap-2 text-xs text-slate-500">
              <Terminal className="w-3.5 h-3.5" /> Progress log
            </div>
            <div ref={logRef} className="bg-white border border-slate-200 rounded-lg p-3 font-mono text-[11px] h-64 overflow-y-auto space-y-1.5">
              {campaign.logs.map(log => (
                <div key={log.id} className="flex items-start gap-2 leading-tight">
                  <span className="text-slate-400 shrink-0">{new Date(log.timestamp).toLocaleTimeString()}</span>
                  <span className={`px-1 rounded text-[10px] uppercase font-bold shrink-0 ${phaseClass[log.phase] || phaseClass.system}`}>{log.phase}</span>
                  {log.investorName && <span className="text-slate-700 font-semibold shrink-0">[{log.investorName}]</span>}
                  <span
                    className={
                      log.level === 'success' ? 'text-emerald-700' : log.level === 'warn' ? 'text-amber-700' : log.level === 'error' ? 'text-red-600' : 'text-slate-700'
                    }
                  >
                    {log.message}
                  </span>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-slate-500">You can close this window — the run keeps going on the server.</span>
              <div className="flex gap-2">
                {running && (
                  <button onClick={pause} className="px-4 py-2 rounded-lg border border-slate-300 hover:bg-slate-50 flex items-center gap-1.5 text-sm cursor-pointer">
                    <Pause className="w-4 h-4" /> Pause
                  </button>
                )}
                {(campaign.status === 'paused' || campaign.status === 'error') && (
                  <button onClick={resume} className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white flex items-center gap-1.5 text-sm cursor-pointer">
                    <Play className="w-4 h-4 fill-current" /> Resume
                  </button>
                )}
                {!running && (
                  <button onClick={() => setShowForm(true)} className="px-4 py-2 rounded-lg border border-slate-300 hover:bg-slate-50 flex items-center gap-1.5 text-sm cursor-pointer">
                    <RotateCw className="w-4 h-4" /> {campaign.mode === 'upgrade' ? 'New run' : 'Start next run'}
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="my-10 text-center text-slate-500 text-sm">
            <Loader2 className="w-5 h-5 animate-spin inline" />
          </div>
        )}

        {error && <div className="mt-2 p-2 rounded bg-red-50 border border-red-200 text-red-800 text-xs">{error}</div>}
      </div>
    </div>
  );
};
