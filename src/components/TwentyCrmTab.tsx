import React, { useState, useMemo } from 'react';
import { 
  Database, 
  Search, 
  Filter, 
  Download, 
  Plus, 
  Kanban, 
  Table as TableIcon, 
  Sparkles, 
  FileSpreadsheet, 
  FileCode, 
  Mail,
  RotateCcw
} from 'lucide-react';
import { Investor, OutreachStatus, StartupProfile, Audience } from '../types';
import { textFor } from '../data/audience';
import { openInGoogleSheets } from '../services/sheets';
import { TwentyTable } from './TwentyTable';
import { TwentyKanban } from './TwentyKanban';

interface TwentyCrmTabProps {
  investors: Investor[];
  startup: StartupProfile;
  onOpenInvestorDetail: (inv: Investor) => void;
  onUpdateStatus: (id: string, newStatus: OutreachStatus) => void;
  onUpdateFollowUp: (id: string, newDate: string) => void;
  onDeleteInvestor: (id: string) => void;
  onAddInvestor: (newInv: Investor) => void;
  onClearCrm: () => void;
  audience?: Audience;
  showToast?: (msg: string, error?: boolean) => void;
  /** contacts hidden because they ask for money upfront */
  hiddenCount?: number;
  hiddenReasons?: Record<string, number>;
  showHidden?: boolean;
  onToggleHidden?: () => void;
}

export const TwentyCrmTab: React.FC<TwentyCrmTabProps> = ({
  investors,
  startup,
  onOpenInvestorDetail,
  onUpdateStatus,
  onUpdateFollowUp,
  onDeleteInvestor,
  onAddInvestor,
  onClearCrm,
  audience = 'investors',
  showToast = (m: string) => alert(m),
  hiddenCount = 0,
  hiddenReasons = {},
  showHidden = false,
  onToggleHidden
}) => {
  const [sheetBusy, setSheetBusy] = useState(false);
  const T = textFor(audience);
  const [viewMode, setViewMode] = useState<'table' | 'kanban'>('table');
  const [searchFilter, setSearchFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [stageFilter, setStageFilter] = useState<string>('all');
  const [isAddingNew, setIsAddingNew] = useState(false);

  // New Lead Form State
  const [newName, setNewName] = useState('');
  const [newFirm, setNewFirm] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newWebsite, setNewWebsite] = useState('');
  const [newStage, setNewStage] = useState('Pre-seed');
  const [newCheck, setNewCheck] = useState('');
  const [newLinkedin, setNewLinkedin] = useState('');

  // Filtered Investors
  const filteredInvestors = useMemo(() => {
    return investors.filter(inv => {
      const q = searchFilter.toLowerCase();
      const matchesSearch = 
        !q ||
        inv.name.toLowerCase().includes(q) ||
        inv.firm.toLowerCase().includes(q) ||
        inv.location.toLowerCase().includes(q) ||
        inv.portfolio.some(p => p.toLowerCase().includes(q)) ||
        inv.industries.some(i => i.toLowerCase().includes(q));

      const matchesStatus = statusFilter === 'all' || inv.outreach.status === statusFilter;
      const matchesStage = stageFilter === 'all' || inv.stage === stageFilter;

      return matchesSearch && matchesStatus && matchesStage;
    });
  }, [investors, searchFilter, statusFilter, stageFilter]);

  // Metric counts
  const hotCount = investors.filter(i => i.fitScore.status === 'hot').length;
  const contactedCount = investors.filter(i => i.outreach.status === 'contacted').length;
  const repliedCount = investors.filter(i => i.outreach.status === 'replied').length;
  const meetingCount = investors.filter(i => i.outreach.status === 'meeting').length;
  // Public contact info: of the people we deep-researched, how many publish an email vs a phone number
  const researched = investors.filter(i => i.researchDepth !== 'quick');
  const pctOf = (n: number) => (researched.length ? Math.round((n / researched.length) * 100) : 0);
  const emailPct = pctOf(researched.filter(i => !!i.email).length);
  const phonePct = pctOf(researched.filter(i => !!i.phone).length);

  const handleCreateCustomLead = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName || !newFirm) return;

    const newInv: Investor = {
      id: `inv-${Date.now()}`,
      name: newName,
      title: audience === 'experts' ? 'Fundraising expert' : 'Partner',
      audience,
      firm: newFirm,
      website: newWebsite,
      email: newEmail,
      linkedin: newLinkedin,
      location: '',
      stage: newStage as any,
      checkSizeFormatted: newCheck || 'Unknown',
      checkSizeMin: 0,
      checkSizeMax: 0,
      industries: [],
      portfolio: [],
      recentInvestments: [],
      thesis: '',
      contactRoute: newEmail ? 'Email' : newLinkedin ? 'LinkedIn connection' : 'Unknown',
      activePartner: newName,
      fitScore: {
        total: 0,
        thesisMatch: 0,
        stageMatch: 0,
        sectorMatch: 0,
        checkSizeMatch: 0,
        synergyMatch: 0,
        status: 'cold',
        verdict: 'Not scored yet — open the AI Scoring tab and click Re-score.',
        whyInvest: [],
        hesitations: [],
        keyTalkingPoint: ''
      },
      researchNotes: 'Manually added.',
      extractedData: {
        rawUrl: newWebsite,
        crawledAt: new Date().toISOString(),
        pageTitle: '',
        metaDescription: '',
        extractedTextExcerpt: '',
        keyQuotes: [],
        portfolioFound: [],
        detectedCheckSize: newCheck,
        detectedContactEmail: newEmail
      },
      outreach: {
        status: 'discovered',
        sequenceGenerated: false,
        sequences: [],
        sentStepsCount: 0
      },
      tags: ['Manual Entry'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    onAddInvestor(newInv);
    setIsAddingNew(false);
    setNewName('');
    setNewFirm('');
    setNewEmail('');
    setNewLinkedin('');
    setNewWebsite('');
  };

  return (
    <div className="space-y-5">
      
      {/* Metrics Row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
          <div className="text-xs text-slate-500 uppercase">Total {T.many}</div>
          <div className="text-xl font-bold text-slate-900 mt-0.5">{investors.length}</div>
          <div className="text-[11px] text-slate-500 mt-1">In your list</div>
        </div>

        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
          <div className="text-xs text-emerald-600">HOT LEADS</div>
          <div className="text-xl font-bold text-emerald-600 mt-0.5">{hotCount}</div>
          <div className="text-[11px] text-slate-500 mt-1">Score 75+</div>
        </div>

        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
          <div className="text-xs text-purple-600">CONTACTED</div>
          <div className="text-xl font-bold text-purple-700 mt-0.5">{contactedCount}</div>
          <div className="text-[11px] text-slate-500 mt-1">Waiting for reply</div>
        </div>

        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
          <div className="text-xs text-cyan-600">MEETINGS BOOKED</div>
          <div className="text-xl font-bold text-cyan-700 mt-0.5">{meetingCount}</div>
          <div className="text-[11px] text-slate-500 mt-1">{repliedCount} replies</div>
        </div>

        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3" title="Of the people the agent deep-researched, how many publish an email address vs a phone number">
          <div className="text-xs text-slate-600 uppercase">Public contact info</div>
          <div className="mt-1.5 space-y-1.5 text-[11px] text-slate-600">
            {([['Email', emailPct, 'bg-emerald-500'], ['Phone', phonePct, 'bg-sky-500']] as const).map(([l, v, c]) => (
              <div key={l} className="flex items-center gap-1.5">
                <span className="w-9">{l}</span>
                <div className="flex-1 bg-slate-200 rounded-full h-1.5 overflow-hidden">
                  <div className={`${c} h-1.5`} style={{ width: `${v}%` }} />
                </div>
                <span className="w-8 text-right font-semibold text-slate-800">{v}%</span>
              </div>
            ))}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            {researched.length
              ? emailPct === phonePct
                ? `Same for both · ${researched.length} researched`
                : `${emailPct > phonePct ? 'Email' : 'Phone'} is more common · ${researched.length} researched`
              : 'No deep-researched people yet'}
          </div>
        </div>
      </div>

      {(hiddenCount > 0 || showHidden) && (
        <div className="text-xs rounded-lg border border-amber-200 bg-amber-50 text-amber-900 px-3 py-2 flex flex-wrap items-center justify-between gap-2">
          <span>
            {showHidden
              ? `Showing ${hiddenCount} filtered-out ${T.many} (normally hidden — they are never emailed).`
              : `${hiddenCount} hidden (not deleted) — ${Object.entries(hiddenReasons)
                  .sort((a, b) => b[1] - a[1])
                  .map(([r, n]) => `${n} ${r}`)
                  .join(' · ')}. They are never emailed.`}
          </span>
          {onToggleHidden && (
            <button onClick={onToggleHidden} className="underline font-medium cursor-pointer">
              {showHidden ? 'Hide them again' : 'Show them'}
            </button>
          )}
        </div>
      )}

      {/* Control Bar: Search, Filters, View Mode & Export */}
      <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 text-xs">
        
        {/* Left: Search input */}
        <div className="relative flex-1">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-2.5" />
          <input
            type="text"
            value={searchFilter}
            onChange={e => setSearchFilter(e.target.value)}
            placeholder={audience === 'experts' ? 'Search experts, companies, clients, location...' : 'Search investors, firms, portfolio companies, location...'}
            className="w-full bg-white border border-slate-200 rounded pl-8 pr-3 py-1.5 text-slate-900 focus:outline-none focus:border-emerald-400 text-xs"
          />
        </div>

        {/* Middle: Filters */}
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="bg-white border border-slate-200 rounded px-2.5 py-1.5 text-slate-700 focus:outline-none focus:border-emerald-400"
          >
            <option value="all">All Statuses</option>
            <option value="discovered">Discovered</option>
            <option value="researched">Researched</option>
            <option value="hot">🔥 Hot Leads</option>
            <option value="warm">⚡ Warm Leads</option>
            <option value="contacted">Contacted</option>
            <option value="replied">Replied</option>
            <option value="meeting">Meeting Booked</option>
            <option value="passed">Passed</option>
          </select>

          <select
            value={stageFilter}
            onChange={e => setStageFilter(e.target.value)}
            className="bg-white border border-slate-200 rounded px-2.5 py-1.5 text-slate-700 focus:outline-none focus:border-emerald-400"
          >
            <option value="all">All Stages</option>
            <option value="Pre-seed">Pre-seed</option>
            <option value="Seed">Seed</option>
            <option value="Series A">Series A</option>
          </select>
        </div>

        {/* Right: View Toggle, Add Lead & Exports */}
        <div className="flex items-center gap-2 shrink-0">
          
          {/* Table / Kanban switch */}
          <div className="flex items-center border border-slate-200 rounded overflow-hidden bg-white">
            <button
              onClick={() => setViewMode('table')}
              className={`p-1.5 transition-colors cursor-pointer ${
                viewMode === 'table' ? 'bg-slate-100 text-slate-900' : 'text-slate-500 hover:text-slate-800'
              }`}
              title="Table view"
            >
              <TableIcon className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setViewMode('kanban')}
              className={`p-1.5 transition-colors cursor-pointer ${
                viewMode === 'kanban' ? 'bg-slate-100 text-slate-900' : 'text-slate-500 hover:text-slate-800'
              }`}
              title="Board view"
            >
              <Kanban className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Add custom lead */}
          <button
            onClick={() => setIsAddingNew(!isAddingNew)}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-800 transition-colors cursor-pointer font-medium"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add {T.one}</span>
          </button>

          {/* Export Dropdown buttons */}
          <div className="flex items-center gap-1">
            <button
              onClick={async () => {
                setSheetBusy(true);
                await openInGoogleSheets(audience, showToast);
                setSheetBusy(false);
              }}
              disabled={sheetBusy}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded bg-slate-50 border border-slate-200 hover:border-slate-300 text-slate-700 hover:text-slate-900 transition-colors cursor-pointer disabled:opacity-60"
              title="Create a Google Sheet of this list in your Google Drive and open it"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" />
              <span>{sheetBusy ? 'Creating sheet…' : 'Open in Google Sheets'}</span>
            </button>
          </div>

        </div>

      </div>

      {/* Add New Custom Lead Drawer */}
      {isAddingNew && (
        <form onSubmit={handleCreateCustomLead} className="p-4 bg-slate-50 border border-emerald-300 rounded-lg space-y-3 text-xs">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-slate-900">Add {audience === 'experts' ? 'an expert' : 'an investor'} you already know</span>
            <button 
              type="button" 
              onClick={() => setIsAddingNew(false)}
              className="text-slate-500 hover:text-slate-800"
            >
              Cancel
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <input
              type="text"
              placeholder="Full name"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              className="bg-white border border-slate-200 rounded px-2.5 py-1.5 text-slate-900"
              required
            />
            <input
              type="text"
              placeholder="Firm / angel group (or Independent Angel)"
              value={newFirm}
              onChange={e => setNewFirm(e.target.value)}
              className="bg-white border border-slate-200 rounded px-2.5 py-1.5 text-slate-900"
              required
            />
            <input
              type="email"
              placeholder="Direct Email"
              value={newEmail}
              onChange={e => setNewEmail(e.target.value)}
              className="bg-white border border-slate-200 rounded px-2.5 py-1.5 text-slate-900"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <input
              type="url"
              placeholder="Website URL"
              value={newWebsite}
              onChange={e => setNewWebsite(e.target.value)}
              className="bg-white border border-slate-200 rounded px-2.5 py-1.5 text-slate-900"
            />
            <select
              value={newStage}
              onChange={e => setNewStage(e.target.value)}
              className="bg-white border border-slate-200 rounded px-2.5 py-1.5 text-slate-900"
            >
              <option value="Pre-seed">Pre-seed</option>
              <option value="Seed">Seed</option>
              <option value="Series A">Series A</option>
            </select>
            <input
              type="text"
              placeholder="Check Size (e.g. $50k - $150k)"
              value={newCheck}
              onChange={e => setNewCheck(e.target.value)}
              className="bg-white border border-slate-200 rounded px-2.5 py-1.5 text-slate-900"
            />
          </div>

          <input
            type="url"
            placeholder="LinkedIn profile URL (optional, e.g. https://www.linkedin.com/in/...)"
            value={newLinkedin}
            onChange={e => setNewLinkedin(e.target.value)}
            className="w-full bg-white border border-slate-200 rounded px-2.5 py-1.5 text-slate-900"
          />

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="submit"
              className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded text-xs transition-colors cursor-pointer"
            >
              Save to CRM
            </button>
          </div>
        </form>
      )}

      {/* Main View: Table or Kanban */}
      {viewMode === 'table' ? (
        <TwentyTable
          audience={audience}
          investors={filteredInvestors}
          onOpenInvestorDetail={onOpenInvestorDetail}
          onUpdateStatus={onUpdateStatus}
          onUpdateFollowUp={onUpdateFollowUp}
          onDeleteInvestor={onDeleteInvestor}
        />
      ) : (
        <TwentyKanban
          investors={filteredInvestors}
          onOpenInvestorDetail={onOpenInvestorDetail}
          onUpdateStatus={onUpdateStatus}
        />
      )}

      {/* Footer helper */}
      <div className="flex items-center justify-between text-xs text-slate-500 pt-2">
        <span>Showing {filteredInvestors.length} of {investors.length}</span>
        <button
          onClick={onClearCrm}
          className="text-slate-500 hover:text-red-700 flex items-center gap-1 cursor-pointer transition-colors"
        >
          <RotateCcw className="w-3 h-3" />
          <span>Clear all {T.many}</span>
        </button>
      </div>

    </div>
  );
};
