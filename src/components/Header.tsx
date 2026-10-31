import React from 'react';
import { Search, Users, Mail, BarChart3, Settings, Play, Building2, HelpCircle, ShoppingCart } from 'lucide-react';
import { StartupProfile, HealthInfo, Audience } from '../types';
import { textFor } from '../data/audience';

export type TabId = 'brain' | 'discovery' | 'scoring' | 'crm' | 'outreach';

interface HeaderProps {
  activeTab: TabId;
  setActiveTab: (tab: TabId) => void;
  startup: StartupProfile;
  health: HealthInfo | null;
  onOpenArchitectureModal: () => void;
  onOpenSettingsModal: () => void;
  onOpenRunnerModal: () => void;
  totalInvestorsCount: number;
  hotLeadsCount: number;
  dueCount: number;
  audience: Audience;
  onChangeAudience: (a: Audience) => void;
  audienceCounts: Record<Audience, number>;
  /** people hidden by the filters (upfront fees, outside the USA, not real experts) */
  hiddenCounts?: Record<Audience, number>;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  setActiveTab,
  startup,
  health,
  onOpenArchitectureModal,
  onOpenSettingsModal,
  onOpenRunnerModal,
  totalInvestorsCount,
  hotLeadsCount,
  dueCount,
  audience,
  onChangeAudience,
  audienceCounts,
  hiddenCounts
}) => {
  const hid = (a: Audience) => (hiddenCounts?.[a] ? ` · ${hiddenCounts[a]} hidden` : '');
  const T = textFor(audience);
  const tab = (id: TabId, icon: React.ReactNode, label: string, badge?: React.ReactNode) => (
    <button
      onClick={() => setActiveTab(id)}
      className={`flex items-center gap-2 px-3.5 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
        activeTab === id ? 'bg-emerald-50 text-emerald-700' : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100'
      }`}
    >
      {icon}
      <span>{label}</span>
      {badge}
    </button>
  );

  const aiOk = !!health?.ai.configured;

  return (
    <header className="bg-white border-b border-slate-200 sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16 gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl shadow-sm bg-emerald-600 flex items-center justify-center text-white shrink-0">
              <ShoppingCart className="w-5 h-5" />
            </div>
            <div className="min-w-0 leading-tight">
              <div className="font-semibold text-slate-900 text-base truncate">{startup.name}</div>
              <div className="text-xs text-slate-500">Fundraising Agent</div>
            </div>
            <label className="flex items-center gap-1.5 ml-1 sm:ml-3 min-w-0" title="Choose what the agent looks for. You can switch any time — each has its own list.">
              <span className="hidden lg:inline text-xs text-slate-500 whitespace-nowrap">Looking for</span>
              <select
                value={audience}
                onChange={e => onChangeAudience(e.target.value as Audience)}
                className="max-w-[11rem] sm:max-w-none bg-emerald-50 border border-emerald-300 text-emerald-900 text-sm font-semibold rounded-lg pl-2.5 pr-7 py-1.5 cursor-pointer focus:outline-none focus:ring-2 focus:ring-emerald-300"
              >
                <option value="investors">Investors ({audienceCounts.investors}{hid('investors')})</option>
                <option value="experts">Fundraising experts ({audienceCounts.experts}{hid('experts')})</option>
              </select>
            </label>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <span
              className={`hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                aiOk ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
              }`}
              title="AI connection"
            >
              <span className={`w-1.5 h-1.5 rounded-full ${aiOk ? 'bg-emerald-500' : 'bg-amber-500'}`} />
              {health ? (aiOk ? 'AI connected' : 'AI not connected') : 'Connecting…'}
            </span>
            <button
              onClick={onOpenArchitectureModal}
              className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
              title="How it works"
            >
              <HelpCircle className="w-5 h-5" />
            </button>
            <button
              onClick={onOpenSettingsModal}
              className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
              title="Settings"
            >
              <Settings className="w-5 h-5" />
            </button>
            <button
              onClick={onOpenRunnerModal}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg shadow-sm transition-colors cursor-pointer"
            >
              <Play className="w-4 h-4 fill-current" />
              <span className="hidden sm:inline">{T.find}</span>
            </button>
          </div>
        </div>

        <nav className="flex items-center gap-1 py-2 overflow-x-auto no-scrollbar">
          {tab('brain', <Building2 className="w-4 h-4" />, 'Your App')}
          {tab('discovery', <Search className="w-4 h-4" />, 'Search')}
          {tab(
            'scoring',
            <BarChart3 className="w-4 h-4" />,
            'Scores',
            hotLeadsCount > 0 ? <span className="text-xs px-1.5 rounded-full bg-emerald-100 text-emerald-700">{hotLeadsCount}</span> : undefined
          )}
          {tab(
            'crm',
            <Users className="w-4 h-4" />,
            T.Many,
            <span className="text-xs px-1.5 rounded-full bg-slate-100 text-slate-600">{totalInvestorsCount}</span>
          )}
          {tab(
            'outreach',
            <Mail className="w-4 h-4" />,
            'Outreach',
            dueCount > 0 ? <span className="text-xs px-1.5 rounded-full bg-amber-100 text-amber-700">{dueCount} due</span> : undefined
          )}
        </nav>
      </div>
    </header>
  );
};
