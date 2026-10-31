import React, { useEffect, useState } from 'react';
import { Brain, Sparkles, Save, Loader2, Play, Upload, Linkedin, Globe, AlertTriangle, RotateCcw } from 'lucide-react';
import { StartupProfile, AppSettings, Investor, InvestmentStage } from '../types';
import { audienceOf, textFor } from '../data/audience';
import { api } from '../services/api';
import { DEFAULT_STARTUP } from '../data/defaultStartup';
import type { TabId } from './Header';

interface Props {
  startup: StartupProfile;
  settings: AppSettings;
  investors: Investor[];
  onSaveStartup: (s: StartupProfile, msg?: string) => void;
  onOpenRunnerModal: () => void;
  onOpenInvestorDetail: (i: Investor) => void;
  goTo: (t: TabId) => void;
  showToast: (msg: string, error?: boolean) => void;
}

const lines = (s: string) => s.split('\n').map(l => l.trim()).filter(Boolean);
const input = 'w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm focus:outline-none focus:border-emerald-500';
const label = 'block text-xs font-medium text-slate-600 mb-1';

export const ProductBrainTab: React.FC<Props> = ({ startup, settings, investors, onSaveStartup, onOpenRunnerModal, goTo, showToast }) => {
  const [form, setForm] = useState<StartupProfile>(startup);
  const [features, setFeatures] = useState((startup.keyFeatures || []).join('\n'));
  const [traction, setTraction] = useState(startup.tractionHighlights.join('\n'));
  const [liQueries, setLiQueries] = useState((startup.linkedinSearchQueries || []).join('\n'));
  const [webQueries, setWebQueries] = useState((startup.webSearchQueries || []).join('\n'));
  const [analyzing, setAnalyzing] = useState(false);
  const [dirty, setDirty] = useState(false);

  // when the agent updates the profile (e.g. AI analysis), refresh the form
  useEffect(() => {
    setForm(startup);
    setFeatures((startup.keyFeatures || []).join('\n'));
    setTraction(startup.tractionHighlights.join('\n'));
    setLiQueries((startup.linkedinSearchQueries || []).join('\n'));
    setWebQueries((startup.webSearchQueries || []).join('\n'));
    setDirty(false);
  }, [startup]);

  const set = (patch: Partial<StartupProfile>) => {
    setForm(f => ({ ...f, ...patch }));
    setDirty(true);
  };

  const collect = (): StartupProfile => ({
    ...form,
    keyFeatures: lines(features),
    tractionHighlights: lines(traction),
    linkedinSearchQueries: lines(liQueries).map(q => (/site:linkedin\.com/i.test(q) ? q : `site:linkedin.com/in ${q}`)),
    webSearchQueries: lines(webQueries)
  });

  const save = () => {
    onSaveStartup(collect());
    setDirty(false);
  };

  const analyze = async () => {
    const current = collect();
    setAnalyzing(true);
    try {
      const { intel } = await api.analyzeProduct(current, settings);
      onSaveStartup({ ...current, ...intel }, `AI analysis complete — confidence ${intel.aiConfidence ?? '?'}%`);
    } catch (e: any) {
      showToast(e?.message || 'Analysis failed', true);
    } finally {
      setAnalyzing(false);
    }
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 300_000 || !/\.(txt|md|csv|json|html?)$/i.test(file.name)) {
      showToast('Upload a text file (.txt, .md, .csv, .html) under 300 KB. For PDFs/decks, copy-paste the text into "Anything else" instead.', true);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      set({ extraContext: `${form.extraContext || ''}\n\n--- ${file.name} ---\n${String(reader.result).slice(0, 20000)}`.trim() });
      showToast(`Added ${file.name} to the agent's knowledge — click Save`);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const List = ({ title, items }: { title: string; items?: string[] }) =>
    items && items.length ? (
      <div>
        <div className="text-[11px] uppercase font-bold tracking-wider text-slate-500 mb-1">{title}</div>
        <ul className="space-y-0.5 text-xs text-slate-700">
          {items.map((x, i) => (
            <li key={i} className="flex gap-1.5">
              <span className="text-pink-600">·</span>
              <span>{x}</span>
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  const hasIntel = !!startup.aiGeneratedAt;
  const missingRaise = !form.targetRaise;

  return (
    <div className="space-y-5">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Your app</h1>
          <p className="text-sm text-slate-500 mt-0.5">What the agent knows about {form.name || 'your app'}.</p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={analyze}
            disabled={analyzing}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-white border border-slate-300 hover:bg-slate-50 text-slate-800 text-sm font-semibold rounded-lg cursor-pointer disabled:opacity-50"
          >
            {analyzing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {analyzing ? 'Analysing…' : hasIntel ? 'Re-analyse with AI' : 'Analyse with AI'}
          </button>
          <button
            onClick={onOpenRunnerModal}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold rounded-lg cursor-pointer"
          >
            <Play className="w-3.5 h-3.5 fill-current" /> {textFor(audienceOf(settings)).find}
          </button>
        </div>
      </div>

      {missingRaise && (
        <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-xs flex gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>
            Add how much you're raising and any real traction — it makes your outreach much stronger.
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* LEFT: founder-supplied facts */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold text-slate-900">About your app</div>
            <button
              onClick={() => {
                if (confirm('Reset the profile to the original SafeCart Kids details?')) onSaveStartup({ ...DEFAULT_STARTUP });
              }}
              className="text-xs text-slate-500 hover:text-slate-800 flex items-center gap-1 cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" /> Reset
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={label}>App / company name</label>
              <input className={input} value={form.name} onChange={e => set({ name: e.target.value })} />
            </div>
            <div>
              <label className={label}>Website</label>
              <input className={input} value={form.website || ''} onChange={e => set({ website: e.target.value })} placeholder="https://..." />
            </div>
          </div>
          <div>
            <label className={label}>One-liner</label>
            <textarea rows={2} className={input} value={form.oneLiner} onChange={e => set({ oneLiner: e.target.value })} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={label}>Category</label>
              <input className={input} value={form.category} onChange={e => set({ category: e.target.value })} />
            </div>
            <div>
              <label className={label}>Location</label>
              <input className={input} value={form.location} onChange={e => set({ location: e.target.value })} />
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label className={label}>Stage</label>
              <select className={input} value={form.stage} onChange={e => set({ stage: e.target.value as InvestmentStage })}>
                {['Pre-seed', 'Seed', 'Series A'].map(s => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={label}>Raising</label>
              <input className={input} value={form.targetRaise} onChange={e => set({ targetRaise: e.target.value })} placeholder="e.g. $500k" />
            </div>
            <div>
              <label className={label}>Min check</label>
              <input className={input} value={form.checkSizeMin} onChange={e => set({ checkSizeMin: e.target.value })} placeholder="$10k" />
            </div>
            <div>
              <label className={label}>Max check</label>
              <input className={input} value={form.checkSizeMax} onChange={e => set({ checkSizeMax: e.target.value })} placeholder="$150k" />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={label}>Founder name (signs emails)</label>
              <input className={input} value={form.founderName || ''} onChange={e => set({ founderName: e.target.value })} />
            </div>
            <div>
              <label className={label}>Founder email (reply-to)</label>
              <input className={input} value={form.founderEmail || ''} onChange={e => set({ founderEmail: e.target.value })} />
            </div>
          </div>
          <div>
            <label className={label}>Key features (one per line)</label>
            <textarea rows={5} className={`${input} text-xs`} value={features} onChange={e => (setFeatures(e.target.value), setDirty(true))} />
          </div>
          <div>
            <label className={label}>Real traction (one per line)</label>
            <textarea
              rows={3}
              className={`${input} text-xs`}
              value={traction}
              onChange={e => (setTraction(e.target.value), setDirty(true))}
              placeholder="e.g. 1,200 families on the waitlist"
            />
          </div>
          <div>
            <label className={label}>Problem</label>
            <textarea rows={3} className={input} value={form.problem} onChange={e => set({ problem: e.target.value })} />
          </div>
          <div>
            <label className={label}>Solution / what makes it special</label>
            <textarea rows={3} className={input} value={form.secretSauce} onChange={e => set({ secretSauce: e.target.value })} />
          </div>
          <div>
            <label className={label}>Ideal investors</label>
            <textarea rows={2} className={input} value={form.idealInvestorTraits} onChange={e => set({ idealInvestorTraits: e.target.value })} />
          </div>
          <div>
            <div className="flex items-center justify-between">
              <label className={label}>Anything else (pitch deck text, notes…)</label>
              <label className="text-xs text-pink-700 hover:text-pink-800 cursor-pointer flex items-center gap-1 mb-1">
                <Upload className="w-3 h-3" /> Upload text file
                <input type="file" className="hidden" onChange={onFile} accept=".txt,.md,.csv,.json,.html,.htm" />
              </label>
            </div>
            <textarea rows={4} className={input} value={form.extraContext || ''} onChange={e => set({ extraContext: e.target.value })} />
          </div>
          <div className="flex justify-end">
            <button
              onClick={save}
              disabled={!dirty}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded cursor-pointer disabled:opacity-40"
            >
              <Save className="w-3.5 h-3.5" /> Save profile
            </button>
          </div>
        </div>

        {/* RIGHT: AI understanding */}
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-900">
                <Brain className="w-4 h-4 text-pink-600" /> AI summary
              </div>
              {hasIntel && (
                <span className="text-[11px] text-slate-500">
                  Updated {new Date(startup.aiGeneratedAt!).toLocaleDateString()}
                </span>
              )}
            </div>
            {!hasIntel ? (
              <div className="text-xs text-slate-500 py-6 text-center">
                Click <b className="text-slate-700">Analyse with AI</b> to build your investor profile.
              </div>
            ) : (
              <div className="space-y-3">
                {startup.productDescription && <p className="text-xs text-slate-800 leading-relaxed">{startup.productDescription}</p>}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <List title="Who pays" items={startup.targetCustomers} />
                  <List title="Who uses it" items={startup.endUsers} />
                </div>
                {startup.businessModel && (
                  <div>
                    <div className="text-[11px] uppercase font-bold tracking-wider text-slate-500 mb-1">Business model</div>
                    <p className="text-xs text-slate-700">{startup.businessModel}</p>
                  </div>
                )}
                {startup.marketDescription && (
                  <div>
                    <div className="text-[11px] uppercase font-bold tracking-wider text-slate-500 mb-1">Market</div>
                    <p className="text-xs text-slate-700">{startup.marketDescription}</p>
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <List title="Comparable companies" items={startup.competitors} />
                  <List title="Differentiation" items={startup.differentiation} />
                  <List title="Use of funds" items={startup.fundingUse} />
                  <List title="Questions investors will ask" items={startup.risksInvestorsWillAsk} />
                </div>
                {startup.investorKeywords?.length ? (
                  <div>
                    <div className="text-[11px] uppercase font-bold tracking-wider text-slate-500 mb-1">Investor themes</div>
                    <div className="flex flex-wrap gap-1">
                      {startup.investorKeywords.map(k => (
                        <span key={k} className="text-[11px] px-1.5 py-0.5 rounded bg-pink-50 text-pink-800 border border-pink-200">
                          {k}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 space-y-3">
            <div className="text-xs font-semibold text-slate-900">Search plan</div>
            <div>
              <label className={`${label} flex items-center gap-1`}>
                <Linkedin className="w-3 h-3 text-sky-600" /> LinkedIn searches
              </label>
              <textarea
                rows={5}
                className={`${input} text-xs`}
                value={liQueries}
                onChange={e => (setLiQueries(e.target.value), setDirty(true))}
                placeholder={'site:linkedin.com/in "angel investor" "family tech"'}
              />
            </div>
            <div>
              <label className={`${label} flex items-center gap-1`}>
                <Globe className="w-3 h-3 text-cyan-600" /> Web searches
              </label>
              <textarea
                rows={5}
                className={`${input} text-xs`}
                value={webQueries}
                onChange={e => (setWebQueries(e.target.value), setDirty(true))}
                placeholder="pre-seed investors kids fintech"
              />
            </div>
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>{investors.length} investors in CRM</span>
              <div className="flex gap-2">
                <button onClick={() => goTo('discovery')} className="px-3 py-1.5 rounded-lg bg-white border border-slate-300 hover:bg-slate-50 text-slate-800 cursor-pointer">
                  Search manually
                </button>
                <button
                  onClick={save}
                  disabled={!dirty}
                  className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-semibold cursor-pointer disabled:opacity-40"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
