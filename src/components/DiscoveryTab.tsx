import React, { useMemo, useState } from 'react';
import { Search, ExternalLink, Sparkles, Plus, Loader2, CheckCircle2, Linkedin, Globe, Layers, XCircle } from 'lucide-react';
import { Investor, StartupProfile, AppSettings, DiscoveryCandidate } from '../types';
import { api } from '../services/api';
import { audienceOf, textFor, expertQueries } from '../data/audience';
import { targetGeo, withGeo } from '../data/geo';

interface DiscoveryTabProps {
  startup: StartupProfile;
  settings: AppSettings;
  investors: Investor[];
  onAddInvestor: (newInv: Investor) => void;
  onOpenInvestorDetail: (inv: Investor) => void;
  onOpenRunnerModal: () => void;
  showToast: (msg: string, error?: boolean) => void;
}

type Mode = 'linkedin' | 'web' | 'both';

export const DiscoveryTab: React.FC<DiscoveryTabProps> = ({ startup, settings, investors, onAddInvestor, onOpenInvestorDetail, onOpenRunnerModal, showToast }) => {
  const [mode, setMode] = useState<Mode>('linkedin');
  const [query, setQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [candidates, setCandidates] = useState<DiscoveryCandidate[]>([]);
  const [searchInfo, setSearchInfo] = useState<string>('');
  const [processing, setProcessing] = useState<Record<string, 'busy' | 'done' | 'error'>>({});
  const [bulkRunning, setBulkRunning] = useState(false);

  const aud = audienceOf(settings);
  const T = textFor(aud);
  const presets = useMemo(() => {
    const g = targetGeo(startup.location);
    return rawPresets().map(p => ({ ...p, q: withGeo(p.q, g) }));
  }, [aud, startup.linkedinSearchQueries, startup.webSearchQueries, startup.investorKeywords, startup.location]);

  function rawPresets() {
    if (aud === 'experts') {
      const city = (startup.location || '').split(',').slice(0, 2).map(x => x.trim()).join(' ');
      const q = expertQueries((startup.investorKeywords || []).slice(0, 5), city);
      return [...q.linkedin.slice(0, 5).map(x => ({ q: x, mode: 'linkedin' as Mode })), ...q.web.slice(0, 6).map(x => ({ q: x, mode: 'web' as Mode }))];
    }
    const li = (startup.linkedinSearchQueries || []).slice(0, 6).map(q => ({ q, mode: 'linkedin' as Mode }));
    const web = (startup.webSearchQueries || []).slice(0, 6).map(q => ({ q, mode: 'web' as Mode }));
    return [...li, ...web];
  }

  const runSearch = async (q?: string, m: Mode = mode) => {
    setIsSearching(true);
    setSearchInfo('');
    try {
      const res = await api.discover(startup, settings, investors, q ? { query: q, mode: m } : { mode: m });
      const existing = new Set(investors.map(i => i.name.toLowerCase()));
      setCandidates(res.candidates.map(c => ({ ...c, alreadyInCrm: existing.has(c.name.toLowerCase()) })));
      const warn = res.logs.filter(l => /No results|failed/i.test(l));
      setSearchInfo(
        `Searched ${res.queries.length} quer${res.queries.length === 1 ? 'y' : 'ies'}, read ${res.resultsSearched} results → ${res.candidates.length} new ${T.many}.` +
          (warn.length ? ` ⚠ ${warn[0]}` : '')
      );
    } catch (e: any) {
      showToast(e?.message || 'Search failed', true);
    } finally {
      setIsSearching(false);
    }
  };

  const research = async (c: DiscoveryCandidate) => {
    setProcessing(p => ({ ...p, [c.id]: 'busy' }));
    try {
      const { investor } = await api.research(startup, c, settings);
      onAddInvestor(investor);
      setProcessing(p => ({ ...p, [c.id]: 'done' }));
      setCandidates(prev => prev.map(x => (x.id === c.id ? { ...x, alreadyInCrm: true } : x)));
      return true;
    } catch (e: any) {
      setProcessing(p => ({ ...p, [c.id]: 'error' }));
      showToast(`${c.name}: ${e?.message || 'research failed'}`, true);
      return false;
    }
  };

  const researchAll = async () => {
    setBulkRunning(true);
    for (const c of candidates.filter(c => !c.alreadyInCrm && processing[c.id] !== 'done')) {
      await research(c);
    }
    setBulkRunning(false);
  };

  const pending = candidates.filter(c => !c.alreadyInCrm).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Search for {aud === 'experts' ? 'fundraising experts' : 'investors'}</h1>
          <p className="text-sm text-slate-500 mt-0.5">Search LinkedIn and the web, then add the ones you like.</p>
        </div>
        <button
          onClick={onOpenRunnerModal}
          className="flex items-center gap-2 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold rounded-lg cursor-pointer shrink-0"
        >
          <Sparkles className="w-4 h-4" /> Auto-find {T.many}
        </button>
      </div>

      <div className="flex gap-1 p-1 bg-slate-50 border border-slate-200 rounded-lg w-fit text-xs">
        {(
          [
            ['linkedin', <Linkedin key="l" className="w-3.5 h-3.5" />, 'LinkedIn profiles'],
            ['web', <Globe key="w" className="w-3.5 h-3.5" />, aud === 'experts' ? 'Websites & directories' : 'Funds & angel groups'],
            ['both', <Layers key="b" className="w-3.5 h-3.5" />, 'Both']
          ] as const
        ).map(([id, icon, text]) => (
          <button
            key={id}
            onClick={() => setMode(id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded cursor-pointer ${mode === id ? 'bg-slate-200 text-slate-900' : 'text-slate-500 hover:text-slate-900'}`}
          >
            {icon}
            {text}
          </button>
        ))}
      </div>

      {presets.length > 0 && (
        <div>
          <span className="text-xs uppercase font-semibold text-slate-500 tracking-wider block mb-2">
            Suggested searches
          </span>
          <div className="flex flex-wrap gap-2">
            {presets.map((p, idx) => (
              <button
                key={idx}
                onClick={() => {
                  setMode(p.mode);
                  setQuery(p.q);
                  runSearch(p.q, p.mode);
                }}
                className="px-2.5 py-1.5 rounded text-xs border bg-white text-slate-500 border-slate-200 hover:bg-slate-100 hover:text-slate-900 cursor-pointer text-left flex items-center gap-1"
              >
                {p.mode === 'linkedin' ? <Linkedin className="w-3 h-3 text-sky-600" /> : <Globe className="w-3 h-3 text-cyan-600" />}
                <span className="">{p.q.replace(/^site:linkedin\.com\/in\s*/i, '')}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <form
        onSubmit={e => {
          e.preventDefault();
          runSearch(query.trim() || undefined);
        }}
        className="flex flex-col sm:flex-row gap-2"
      >
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-3" />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={
              aud === 'experts'
                ? mode === 'linkedin'
                  ? 'e.g. "fundraising consultant" consumer apps'
                  : 'e.g. pitch deck consultant for seed startups'
                : mode === 'linkedin'
                  ? 'e.g. "angel investor" edtech Arizona'
                  : 'e.g. investors in kids fintech startups'
            }
            className="w-full bg-white border border-slate-200 rounded-lg pl-9 pr-4 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:border-emerald-500"
          />
        </div>
        <button
          type="submit"
          disabled={isSearching}
          className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-lg text-sm flex items-center justify-center gap-1.5 cursor-pointer shrink-0 disabled:opacity-50"
        >
          {isSearching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
          {isSearching ? 'Searching…' : 'Search'}
        </button>
      </form>

      <div>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3 text-xs">
          <span className="text-slate-500">{searchInfo || 'Pick a suggested search or type your own. It takes about a minute.'}</span>
          {pending > 0 && (
            <button
              onClick={researchAll}
              disabled={bulkRunning}
              className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-xs flex items-center gap-1 cursor-pointer disabled:opacity-50 shrink-0"
            >
              {bulkRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
              Research & add all {pending}
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {candidates.map(item => {
            const state = processing[item.id];
            const inCrm = investors.find(i => i.name.toLowerCase() === item.name.toLowerCase());
            return (
              <div key={item.id} className="bg-slate-50 border border-slate-200 hover:border-slate-300 rounded-lg p-4 flex flex-col justify-between space-y-3">
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-slate-900 tracking-tight">{item.name}</h3>
                      <div className="text-xs text-slate-500 font-medium truncate">
                        {item.title ? `${item.title} · ` : ''}
                        {item.firm}
                        {item.location ? <span className="text-slate-500"> · {item.location}</span> : null}
                      </div>
                    </div>
                    <span className="px-1.5 py-0.5 rounded text-[11px] bg-slate-100 text-slate-700 shrink-0">{item.investorType}</span>
                  </div>
                  {item.whyRelevant && <p className="text-xs text-emerald-800 mt-2 leading-relaxed">{item.whyRelevant}</p>}
                  {item.snippet && <p className="text-xs text-slate-500 mt-1.5 line-clamp-2 leading-relaxed">“{item.snippet}”</p>}
                </div>

                <div className="pt-3 border-t border-slate-200 flex items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-3 min-w-0">
                    {item.linkedinUrl && (
                      <a href={item.linkedinUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-sky-600 hover:underline text-xs">
                        <Linkedin className="w-3 h-3" /> Profile
                      </a>
                    )}
                    <a href={item.sourceUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-cyan-600 hover:underline text-xs truncate">
                      Source <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                  </div>

                  {item.alreadyInCrm || state === 'done' ? (
                    <button
                      onClick={() => inCrm && onOpenInvestorDetail(inCrm)}
                      className="flex items-center gap-1 text-emerald-600 text-xs font-medium cursor-pointer"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" /> In CRM
                    </button>
                  ) : (
                    <button
                      onClick={() => research(item)}
                      disabled={state === 'busy'}
                      className="flex items-center gap-1 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-900 rounded font-medium text-xs cursor-pointer disabled:opacity-50 shrink-0"
                    >
                      {state === 'busy' ? (
                        <>
                          <Loader2 className="w-3 h-3 animate-spin" /> Researching…
                        </>
                      ) : state === 'error' ? (
                        <>
                          <XCircle className="w-3 h-3 text-red-600" /> Retry
                        </>
                      ) : (
                        <>
                          <Plus className="w-3 h-3" /> Research & add
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
