import React from 'react';
import { Investor, OutreachStatus } from '../types';
import { ChevronRight, ChevronLeft, Mail, ExternalLink, Calendar } from 'lucide-react';

interface TwentyKanbanProps {
  investors: Investor[];
  onOpenInvestorDetail: (inv: Investor) => void;
  onUpdateStatus: (id: string, newStatus: OutreachStatus) => void;
}

interface ColumnDef {
  key: OutreachStatus;
  label: string;
  badgeColor: string;
}

const COLUMNS: ColumnDef[] = [
  { key: 'discovered', label: 'Discovered', badgeColor: 'bg-slate-100 text-slate-700' },
  { key: 'researched', label: 'Researched', badgeColor: 'bg-cyan-50 text-cyan-600 border border-cyan-200' },
  { key: 'hot', label: 'Hot (75+)', badgeColor: 'bg-emerald-50 text-emerald-600 border border-emerald-200' },
  { key: 'warm', label: 'Warm (55–74)', badgeColor: 'bg-amber-50 text-amber-600 border border-amber-200' },
  { key: 'contacted', label: 'Contacted', badgeColor: 'bg-purple-50 text-purple-600 border border-purple-200' },
  { key: 'replied', label: 'Replied', badgeColor: 'bg-blue-50 text-blue-600 border border-blue-200' },
  { key: 'meeting', label: 'Meeting Booked', badgeColor: 'bg-emerald-100 text-emerald-800 border border-emerald-300' },
  { key: 'passed', label: 'Passed', badgeColor: 'bg-slate-50 text-slate-500' },
];

export const TwentyKanban: React.FC<TwentyKanbanProps> = ({
  investors,
  onOpenInvestorDetail,
  onUpdateStatus
}) => {
  const getNextStage = (current: OutreachStatus): OutreachStatus | null => {
    const order: OutreachStatus[] = ['discovered', 'researched', 'hot', 'contacted', 'replied', 'meeting'];
    const idx = order.indexOf(current);
    if (idx !== -1 && idx < order.length - 1) return order[idx + 1];
    if (current === 'warm') return 'contacted';
    return null;
  };

  const getPrevStage = (current: OutreachStatus): OutreachStatus | null => {
    const order: OutreachStatus[] = ['discovered', 'researched', 'hot', 'contacted', 'replied', 'meeting'];
    const idx = order.indexOf(current);
    if (idx > 0) return order[idx - 1];
    return null;
  };

  return (
    <div className="flex gap-3 overflow-x-auto pb-4 no-scrollbar min-h-[540px]">
      {COLUMNS.map(col => {
        const colInvestors = investors.filter(inv => inv.outreach.status === col.key);

        return (
          <div
            key={col.key}
            className="w-72 shrink-0 bg-white border border-slate-200 rounded-lg flex flex-col max-h-[750px]"
          >
            {/* Column Header */}
            <div className="p-3 border-b border-slate-200 flex items-center justify-between shrink-0 bg-slate-50">
              <span className="font-semibold text-xs text-slate-900 tracking-tight flex items-center gap-1.5">
                <span>{col.label}</span>
              </span>
              <span className={`text-[11px] px-2 py-0.5 rounded font-medium ${col.badgeColor}`}>
                {colInvestors.length}
              </span>
            </div>

            {/* Column Cards */}
            <div className="p-2 space-y-2 overflow-y-auto flex-1 text-xs">
              {colInvestors.length === 0 ? (
                <div className="h-28 flex items-center justify-center text-slate-400 text-xs italic">
                  Empty
                </div>
              ) : (
                colInvestors.map(inv => {
                  const next = getNextStage(inv.outreach.status);
                  const prev = getPrevStage(inv.outreach.status);

                  return (
                    <div
                      key={inv.id}
                      onClick={() => onOpenInvestorDetail(inv)}
                      className="bg-slate-50 border border-slate-200 hover:border-slate-300 rounded-md p-3 transition-colors cursor-pointer group shadow-sm flex flex-col justify-between space-y-2.5"
                    >
                      <div>
                        <div className="flex items-start justify-between gap-1.5">
                          <h4 className="font-semibold text-slate-900 group-hover:text-emerald-800 transition-colors text-xs leading-snug">
                            {inv.name}
                          </h4>
                          <span className={`text-[11px] font-bold shrink-0 ${
                            inv.fitScore.status === 'hot' ? 'text-emerald-600' :
                            inv.fitScore.status === 'warm' ? 'text-amber-600' : 'text-slate-500'
                          }`}>
                            {inv.fitScore.total}%
                          </span>
                        </div>

                        <div className="text-xs text-slate-500 mt-0.5">
                          {inv.firm}
                        </div>

                        <div className="flex items-center gap-2 text-[11px] text-slate-500 mt-2">
                          <span>{inv.stage}</span>
                          <span>·</span>
                          <span className="text-emerald-600 font-semibold">{inv.checkSizeFormatted}</span>
                        </div>

                        <div className="mt-2 flex flex-wrap gap-1">
                          {inv.portfolio.slice(0, 2).map((p, idx) => (
                            <span key={idx} className="text-[10px] px-1 py-0.2 rounded bg-white text-slate-500 border border-slate-200">
                              {p}
                            </span>
                          ))}
                        </div>
                      </div>

                      {/* Card Bottom Controls */}
                      <div 
                        className="pt-2 border-t border-slate-200 flex items-center justify-between text-xs"
                        onClick={e => e.stopPropagation()}
                      >
                        <span className="text-slate-500 text-[11px] truncate max-w-[120px]">
                          {inv.outreach.nextFollowUpDate ? `Due: ${inv.outreach.nextFollowUpDate}` : inv.location}
                        </span>

                        <div className="flex items-center gap-1">
                          {prev && (
                            <button
                              onClick={() => onUpdateStatus(inv.id, prev)}
                              className="p-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-500 hover:text-slate-900 transition-colors cursor-pointer"
                              title={`Move back to ${prev}`}
                            >
                              <ChevronLeft className="w-3 h-3" />
                            </button>
                          )}
                          {next && (
                            <button
                              onClick={() => onUpdateStatus(inv.id, next)}
                              className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 font-medium text-[11px] transition-colors cursor-pointer"
                              title={`Advance to ${next}`}
                            >
                              <span>Next</span>
                              <ChevronRight className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </div>

                    </div>
                  );
                })
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};
