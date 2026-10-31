import React, { useState } from 'react';
import { 
  X, 
  ExternalLink, 
  Mail, 
  Linkedin, 
  Twitter, 
  MapPin, 
  DollarSign, 
  Briefcase, 
  Calendar, 
  Sparkles, 
  Check, 
  Copy, 
  FileText, 
  Globe, 
  ShieldCheck, 
  Send, 
  Save 
} from 'lucide-react';
import { Investor, OutreachStatus, StartupProfile, AppSettings } from '../types';
import { audienceOf, textFor } from '../data/audience';
import { api, gmailComposeUrl } from '../services/api';

interface InvestorDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  investor: Investor | null;
  startup: StartupProfile;
  settings: AppSettings;
  onUpdateInvestor: (updated: Investor) => void;
  showToast: (msg: string, error?: boolean) => void;
}

export const InvestorDetailModal: React.FC<InvestorDetailModalProps> = ({
  isOpen,
  onClose,
  investor,
  startup,
  settings,
  onUpdateInvestor,
  showToast
}) => {
  const [activeSubTab, setActiveSubTab] = useState<'overview' | 'firecrawl' | 'sequences'>('overview');
  const [researchNotes, setResearchNotes] = useState(investor?.researchNotes || '');
  const [responseNotes, setResponseNotes] = useState(investor?.outreach.responseNotes || '');
  const [outreachStatus, setOutreachStatus] = useState<OutreachStatus>(investor?.outreach.status || 'discovered');
  const [nextFollowUpDate, setNextFollowUpDate] = useState(investor?.outreach.nextFollowUpDate || '');
  const [email, setEmail] = useState(investor?.email || '');
  const [linkedin, setLinkedin] = useState(investor?.linkedin || '');
  const [phone, setPhone] = useState(investor?.phone || '');
  const [copiedStep, setCopiedStep] = useState<number | null>(null);
  const [isRescoring, setIsRescoring] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [findingLi, setFindingLi] = useState(false);
  const [deepening, setDeepening] = useState(false);

  if (!isOpen || !investor) return null;
  const T = textFor(audienceOf(investor));

  const handleSaveNotes = () => {
    const updated: Investor = {
      ...investor,
      researchNotes,
      email: email.trim(),
      phone: phone.trim(),
      linkedin: linkedin.trim(),
      outreach: {
        ...investor.outreach,
        status: outreachStatus,
        responseNotes,
        nextFollowUpDate
      },
      updatedAt: new Date().toISOString()
    };
    onUpdateInvestor(updated);
  };

  const handleCopyEmail = (body: string, stepNumber: number) => {
    navigator.clipboard.writeText(body);
    setCopiedStep(stepNumber);
    setTimeout(() => setCopiedStep(null), 2000);
  };

  const handleRegenerateSequence = async () => {
    setIsRegenerating(true);
    try {
      const o = await api.outreach(startup, investor, settings);
      onUpdateInvestor({
        ...investor,
        linkedinNote: o.linkedinNote,
        linkedinMessage: o.linkedinMessage,
        outreach: { ...investor.outreach, sequences: o.sequences, sequenceGenerated: true, templateV: o.templateV },
        updatedAt: new Date().toISOString()
      });
    } catch (e: any) {
      showToast(e?.message || 'AI rewrite failed', true);
    } finally {
      setIsRegenerating(false);
    }
  };

  const handleRescore = async () => {
    setIsRescoring(true);
    try {
      const result = await api.score(startup, investor);
      setResearchNotes(result.researchNotes);
      onUpdateInvestor({ ...investor, fitScore: result.fitScore, researchNotes: result.researchNotes, updatedAt: new Date().toISOString() });
    } catch (e: any) {
      showToast(e?.message || 'Scoring failed', true);
    } finally {
      setIsRescoring(false);
    }
  };

  const handleResearchDeeply = async () => {
    setDeepening(true);
    try {
      const r = await api.researchInvestor(startup, investor, settings);
      setResearchNotes(r.investor.researchNotes || '');
      setEmail(r.investor.email || '');
      setLinkedin(r.investor.linkedin || '');
      setPhone(r.investor.phone || '');
      onUpdateInvestor(r.investor);
      showToast(`Researched ${r.investor.name} — score ${r.investor.fitScore.total}%`);
    } catch (e: any) {
      showToast(e?.message || 'Research failed', true);
    } finally {
      setDeepening(false);
    }
  };

  const handleFindLinkedIn = async () => {
    setFindingLi(true);
    try {
      const r = await api.findLinkedIn(investor.name, investor.firm);
      if (r.linkedin) {
        setLinkedin(r.linkedin);
        onUpdateInvestor({ ...investor, linkedin: r.linkedin });
      } else showToast('No public LinkedIn profile found by search. Try the LinkedIn search link instead.', true);
    } catch (e: any) {
      showToast(e?.message || 'Search failed', true);
    } finally {
      setFindingLi(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/30 backdrop-blur-sm overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-xl max-w-4xl w-full max-h-[92vh] flex flex-col text-slate-800 shadow-2xl my-4">
        
        {/* Top Header */}
        <div className="p-5 border-b border-slate-200 flex items-start justify-between gap-4 shrink-0 bg-slate-50">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-lg bg-slate-100 border border-slate-300 flex items-center justify-center text-lg font-bold text-slate-900 shrink-0">
              {investor.name.split(' ').map(n => n[0]).join('')}
            </div>

            <div>
              <div className="flex items-center gap-2.5 flex-wrap">
                <h2 className="text-lg font-bold text-slate-900 tracking-tight">{investor.name}</h2>
                <span className="text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-300 font-medium">
                  {investor.title} · {investor.firm}
                </span>
                
                {/* Fit Score Pill */}
                <div className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-bold ${
                  investor.fitScore.status === 'hot' 
                    ? 'bg-emerald-50 text-emerald-600 border border-emerald-200' 
                    : investor.fitScore.status === 'warm'
                    ? 'bg-amber-50 text-amber-600 border border-amber-200'
                    : 'bg-slate-50 text-slate-500 border border-slate-200'
                }`}>
                  <span>{investor.fitScore.status === 'hot' ? '🔥' : investor.fitScore.status === 'warm' ? '⚡' : '❄️'}</span>
                  <span>{investor.fitScore.total}% Fit</span>
                </div>
              </div>

              <div className="flex items-center gap-3 text-xs text-slate-500 mt-1.5 flex-wrap">
                <span className="flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5 text-slate-500" />
                  {investor.location}
                </span>
                <span>·</span>
                <span className="flex items-center gap-1">
                  <Briefcase className="w-3.5 h-3.5 text-slate-500" />
                  {investor.stage}
                </span>
                <span>·</span>
                <span className="flex items-center gap-1 text-emerald-600">
                  <DollarSign className="w-3.5 h-3.5 text-emerald-600" />
                  {investor.checkSizeFormatted}
                </span>
                <span>·</span>
                {investor.website && (
                  <a href={investor.website} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-cyan-600 hover:underline">
                    <Globe className="w-3 h-3" />
                    <span>Website</span>
                    <ExternalLink className="w-2.5 h-2.5" />
                  </a>
                )}
                {investor.linkedin && (
                  <a
                    href={investor.linkedin}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-indigo-600 hover:underline"
                  >
                    <Linkedin className="w-3 h-3" />
                    <span>LinkedIn</span>
                  </a>
                )}
              </div>
            </div>
          </div>

          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-900 p-1 rounded hover:bg-slate-100 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {investor.researchDepth === 'quick' && (
          <div className="px-5 py-3 border-b border-amber-200 bg-amber-50 flex items-center justify-between gap-3 flex-wrap shrink-0">
            <p className="text-xs text-amber-800">
              Quick scan only — this score is a first guess. Research deeply to check their website, find an email and write personal outreach.
            </p>
            <button
              onClick={handleResearchDeeply}
              disabled={deepening}
              className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 disabled:opacity-60 text-white text-xs font-semibold cursor-pointer"
            >
              {deepening ? 'Researching… (about a minute)' : 'Research deeply'}
            </button>
          </div>
        )}

        {/* Sub-tab navigation */}
        <div className="flex items-center space-x-2 px-5 border-b border-slate-200 bg-white shrink-0 text-xs">
          <button
            onClick={() => setActiveSubTab('overview')}
            className={`py-2.5 px-3 border-b-2 font-medium transition-colors cursor-pointer ${
              activeSubTab === 'overview'
                ? 'border-emerald-400 text-slate-900'
                : 'border-transparent text-slate-500 hover:text-slate-900'
            }`}
          >
            Overview
          </button>
          <button
            onClick={() => setActiveSubTab('firecrawl')}
            className={`py-2.5 px-3 border-b-2 font-medium transition-colors cursor-pointer ${
              activeSubTab === 'firecrawl'
                ? 'border-indigo-400 text-slate-900'
                : 'border-transparent text-slate-500 hover:text-slate-900'
            }`}
          >
            Sources
          </button>
          <button
            onClick={() => setActiveSubTab('sequences')}
            className={`py-2.5 px-3 border-b-2 font-medium transition-colors cursor-pointer ${
              activeSubTab === 'sequences'
                ? 'border-purple-400 text-slate-900'
                : 'border-transparent text-slate-500 hover:text-slate-900'
            }`}
          >
            Emails ({investor.outreach.sequences?.length || 0})
          </button>
        </div>

        {/* Tab Body */}
        <div className="p-5 overflow-y-auto space-y-5 text-xs flex-1">
          
          {/* TAB 1: OVERVIEW & AI FIT */}
          {activeSubTab === 'overview' && (
            <div className="space-y-5">
              
              {/* Score Breakdown Bar */}
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-emerald-600" />
                    <span className="font-semibold text-slate-900">Fit for {startup.name}</span>
                  </div>
                  <button
                    onClick={handleRescore}
                    disabled={isRescoring}
                    className="text-xs text-slate-500 hover:text-slate-900 underline cursor-pointer disabled:opacity-50"
                  >
                    {isRescoring ? 'Scoring…' : 'Re-score'}
                  </button>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-center">
                  <div className="bg-white p-2.5 rounded border border-slate-200">
                    <div className="text-[11px] text-slate-500 font-medium uppercase">{T.fit.thesis}</div>
                    <div className="text-base font-bold text-slate-900">{investor.fitScore.thesisMatch}%</div>
                  </div>
                  <div className="bg-white p-2.5 rounded border border-slate-200">
                    <div className="text-[11px] text-slate-500 font-medium uppercase">{T.fit.stage}</div>
                    <div className="text-base font-bold text-slate-900">{investor.fitScore.stageMatch}%</div>
                  </div>
                  <div className="bg-white p-2.5 rounded border border-slate-200">
                    <div className="text-[11px] text-slate-500 font-medium uppercase">{T.fit.sector}</div>
                    <div className="text-base font-bold text-slate-900">{investor.fitScore.sectorMatch}%</div>
                  </div>
                  <div className="bg-white p-2.5 rounded border border-slate-200">
                    <div className="text-[11px] text-slate-500 font-medium uppercase">{T.fit.check}</div>
                    <div className="text-base font-bold text-slate-900">{investor.fitScore.checkSizeMatch}%</div>
                  </div>
                  <div className="bg-white p-2.5 rounded border border-slate-200 col-span-2 sm:col-span-1">
                    <div className="text-[11px] text-slate-500 font-medium uppercase">{T.fit.synergy}</div>
                    <div className="text-base font-bold text-emerald-600">{investor.fitScore.synergyMatch}%</div>
                  </div>
                </div>

                <div className="mt-3 text-slate-700 text-xs italic bg-white p-2 rounded border border-slate-200">
                  "{investor.fitScore.verdict}"
                </div>
              </div>

              {/* Why They'll Invest vs Hesitations */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3.5">
                  <h4 className="text-xs font-semibold text-emerald-600 mb-2 flex items-center gap-1.5">
                    <Check className="w-3.5 h-3.5" /> {T.field.why}
                  </h4>
                  <ul className="space-y-1.5 text-slate-700">
                    {investor.fitScore.whyInvest.map((reason, idx) => (
                      <li key={idx} className="flex items-start gap-1.5">
                        <span className="text-emerald-600 font-bold shrink-0">·</span>
                        <span>{reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3.5">
                  <h4 className="text-xs font-semibold text-amber-600 mb-2 flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5" /> Possible concerns
                  </h4>
                  <ul className="space-y-1.5 text-slate-700">
                    {investor.fitScore.hesitations.map((hes, idx) => (
                      <li key={idx} className="flex items-start gap-1.5">
                        <span className="text-amber-600 font-bold shrink-0">·</span>
                        <span>{hes}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* Key Talking Point & Pitch Angle */}
              <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200">
                <div className="text-[11px] uppercase font-bold text-slate-500 tracking-wider mb-1">
                  Best way to open
                </div>
                <div className="text-xs text-slate-900 font-medium">
                  {investor.fitScore.keyTalkingPoint}
                </div>
              </div>

              {/* Portfolio & Industries */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
                  <span className="text-slate-500 block text-xs font-medium mb-1.5">{T.field.portfolio}</span>
                  <div className="flex flex-wrap gap-1.5">
                    {investor.portfolio.map((p, idx) => (
                      <span key={idx} className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 text-xs">
                        {p}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
                  <span className="text-slate-500 block text-xs font-medium mb-1.5">Focus areas</span>
                  <div className="flex flex-wrap gap-1.5">
                    {investor.industries.map((ind, idx) => (
                      <span key={idx} className="px-2 py-0.5 rounded bg-slate-100 text-slate-500 text-xs">
                        {ind}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              {/* Twenty CRM Status & Follow-up Controls */}
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-900">Status & contact</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-slate-500 mb-1">Outreach Status</label>
                    <select
                      value={outreachStatus}
                      onChange={e => setOutreachStatus(e.target.value as OutreachStatus)}
                      className="w-full bg-white border border-slate-200 rounded px-2.5 py-1.5 text-slate-900"
                    >
                      <option value="discovered">Discovered</option>
                      <option value="researched">Researched</option>
                      <option value="hot">Hot (75+)</option>
                      <option value="warm">Warm</option>
                      <option value="contacted">Contacted</option>
                      <option value="replied">Replied</option>
                      <option value="meeting">Meeting Booked</option>
                      <option value="diligence">Diligence</option>
                      <option value="passed">Passed</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-slate-500 mb-1">Direct Email</label>
                    <div className="flex items-center gap-1">
                      <input
                        type="email"
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                        placeholder="not found publicly"
                        className="w-full bg-white border border-slate-200 rounded px-2.5 py-1.5 text-slate-700 text-xs"
                      />
                      <a
                        href={gmailComposeUrl(email, investor.outreach.sequences[0]?.subject || '', investor.outreach.sequences[0]?.body || '')}
                        target="_blank"
                        rel="noreferrer"
                        className="p-2 bg-emerald-50 text-emerald-600 rounded hover:bg-emerald-50 shrink-0"
                        title="Open email 1 in Gmail"
                      >
                        <Send className="w-3.5 h-3.5" />
                      </a>
                    </div>
                  </div>

                  <div>
                    <label className="block text-slate-500 mb-1">Next Follow-Up Date</label>
                    <input
                      type="date"
                      value={nextFollowUpDate}
                      onChange={e => setNextFollowUpDate(e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded px-2.5 py-1.5 text-slate-900"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-500 mb-1">Phone (public)</label>
                    <input
                      type="tel"
                      value={phone}
                      onChange={e => setPhone(e.target.value)}
                      placeholder="not found publicly"
                      className="w-full bg-white border border-slate-200 rounded px-2.5 py-1.5 text-slate-700 text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-500 mb-1">How they charge</label>
                    <div className={`w-full rounded px-2.5 py-1.5 text-xs border ${investor.upfrontFee === 'yes' ? 'bg-red-50 border-red-200 text-red-800' : 'bg-slate-50 border-slate-200 text-slate-700'}`}>
                      {investor.feeModel || 'Unknown'}
                      {investor.upfrontFee === 'yes' ? ' — asks for money upfront (hidden from your list, never auto-emailed)' : investor.upfrontFee === 'no' ? ' — no upfront payment' : ''}
                    </div>
                  </div>
                </div>

                <div>
                  <label className="block text-slate-500 mb-1">LinkedIn profile URL</label>
                  <div className="flex items-center gap-1">
                    <input
                      type="url"
                      value={linkedin}
                      onChange={e => setLinkedin(e.target.value)}
                      placeholder="https://www.linkedin.com/in/..."
                      className="w-full bg-white border border-slate-200 rounded px-2.5 py-1.5 text-slate-700 text-xs"
                    />
                    <button
                      onClick={handleFindLinkedIn}
                      disabled={findingLi}
                      className="px-2.5 py-1.5 rounded bg-sky-100 hover:bg-sky-200 text-sky-900 text-xs shrink-0 cursor-pointer disabled:opacity-50"
                    >
                      {findingLi ? 'Searching…' : 'Find'}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-slate-500 mb-1">Reply / meeting notes</label>
                  <textarea
                    rows={2}
                    value={responseNotes}
                    onChange={e => setResponseNotes(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded p-2 text-slate-900 text-xs"
                  />
                </div>

                <div>
                  <label className="block text-slate-500 mb-1">Research notes</label>
                  <textarea
                    rows={2}
                    value={researchNotes}
                    onChange={e => setResearchNotes(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded p-2 text-slate-900 text-xs"
                  />
                </div>

                <div className="flex justify-end">
                  <button
                    onClick={handleSaveNotes}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-medium rounded text-xs transition-colors cursor-pointer"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>Save</span>
                  </button>
                </div>
              </div>

            </div>
          )}

          {/* TAB 2: FIRECRAWL EXTRACTED RAW WEBPAGE */}
          {activeSubTab === 'firecrawl' && (
            <div className="space-y-4">
              <div className="p-3 bg-indigo-50 border border-indigo-200 rounded-lg flex items-center justify-between">
                <div>
                  <span className="text-indigo-600 font-semibold text-xs block">
                    Pages the agent read
                  </span>
                </div>
                <span className="text-[11px] text-slate-500">
                  Crawled: {new Date(investor.extractedData.crawledAt).toLocaleDateString()}
                </span>
              </div>

              {(investor.sourceUrls?.length || 0) > 0 && (
                <div>
                  <span className="text-slate-500 block text-xs font-medium mb-1">Sources:</span>
                  <ul className="space-y-1">
                    {investor.sourceUrls!.map(u => (
                      <li key={u}>
                        <a href={u} target="_blank" rel="noreferrer" className="text-cyan-600 hover:underline break-all text-xs">
                          {u}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div>
                <span className="text-slate-500 block text-xs font-medium mb-1">Page title:</span>
                <div className="p-2 bg-slate-50 border border-slate-200 rounded text-slate-800 font-medium">
                  {investor.extractedData.pageTitle}
                </div>
              </div>

              <div>
                <span className="text-slate-500 block text-xs font-medium mb-1">Quotes from their site:</span>
                <div className="space-y-1.5">
                  {investor.extractedData.keyQuotes.map((q, idx) => (
                    <div key={idx} className="p-2 rounded bg-slate-50 border border-slate-200 text-slate-700 italic text-xs">
                      "{q}"
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <span className="text-slate-500 block text-xs font-medium mb-1">Website text excerpt:</span>
                <pre className="p-3.5 bg-white border border-slate-200 rounded text-slate-700 text-xs whitespace-pre-wrap max-h-80 overflow-y-auto leading-relaxed">
                  {investor.extractedData.extractedTextExcerpt}
                </pre>
              </div>
            </div>
          )}

          {/* TAB 3: MAUTIC SEQUENCES */}
          {activeSubTab === 'sequences' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-xs font-semibold text-slate-900">
                    Emails for {investor.name}
                  </h4>
                </div>
                <button
                  onClick={handleRegenerateSequence}
                  disabled={isRegenerating}
                  className="px-2.5 py-1 text-xs rounded border border-purple-200 bg-purple-50 text-purple-700 hover:bg-purple-100 cursor-pointer disabled:opacity-50"
                >
                  {isRegenerating ? 'Writing…' : 'Rewrite with AI'}
                </button>
              </div>

              <div className="space-y-3">
                {investor.outreach.sequences?.map(step => (
                  <div key={step.stepNumber} className="border border-slate-200 rounded-lg p-3.5 bg-slate-50">
                    <div className="flex items-center justify-between pb-2 border-b border-slate-200 mb-2">
                      <div className="flex items-center gap-2">
                        <span className="px-1.5 py-0.5 rounded text-[11px] font-bold bg-purple-50 text-purple-700 border border-purple-200">
                          Step {step.stepNumber} · Day {step.dayDelay}
                        </span>
                        <span className="font-medium text-slate-900 text-xs">{step.stepName}</span>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => handleCopyEmail(step.body, step.stepNumber)}
                          className="flex items-center gap-1 px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs transition-colors cursor-pointer"
                        >
                          {copiedStep === step.stepNumber ? (
                            <>
                              <Check className="w-3 h-3 text-emerald-600" />
                              <span className="text-emerald-600">Copied</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3 h-3" />
                              <span>Copy</span>
                            </>
                          )}
                        </button>

                        <a
                          href={gmailComposeUrl(investor.email, step.subject, step.body)}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-1 px-2 py-1 rounded bg-emerald-50 hover:bg-emerald-100 text-emerald-700 text-xs transition-colors"
                          title="Open in Gmail"
                        >
                          <Send className="w-3 h-3" />
                          <span>Send</span>
                        </a>
                      </div>
                    </div>

                    <div className="text-xs text-slate-500 mb-1.5">
                      <strong className="text-slate-700">Subject:</strong> {step.subject}
                    </div>

                    <div className="bg-white p-3 rounded border border-slate-200 text-xs text-slate-800 whitespace-pre-wrap leading-relaxed">
                      {step.body}
                    </div>

                    <div className="mt-2 text-[11px] text-slate-500 italic">
                      {step.rationale}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>

      </div>
    </div>
  );
};
