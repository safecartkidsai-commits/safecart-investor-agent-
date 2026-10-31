import React from 'react';
import { 
  ExternalLink, 
  Mail, 
  Linkedin, 
  ChevronRight, 
  Send, 
  Sparkles,
  Calendar,
  MoreHorizontal,
  Trash2,
  Eye
} from 'lucide-react';
import { Investor, OutreachStatus, Audience } from '../types';
import { textFor } from '../data/audience';

interface TwentyTableProps {
  investors: Investor[];
  onOpenInvestorDetail: (inv: Investor) => void;
  onUpdateStatus: (id: string, newStatus: OutreachStatus) => void;
  onUpdateFollowUp: (id: string, newDate: string) => void;
  onDeleteInvestor: (id: string) => void;
  audience?: Audience;
}

export const TwentyTable: React.FC<TwentyTableProps> = ({
  investors,
  onOpenInvestorDetail,
  onUpdateStatus,
  onUpdateFollowUp,
  onDeleteInvestor,
  audience = 'investors'
}) => {
  const T = textFor(audience);
  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden bg-white">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-xs uppercase tracking-wider">
              <th className="py-3 px-3.5 font-medium">{T.One}</th>
              <th className="py-3 px-3 font-medium">{T.field.stage}</th>
              <th className="py-3 px-3 font-medium">Fit</th>
              <th className="py-3 px-3 font-medium">{T.field.portfolio}</th>
              <th className="py-3 px-3 font-medium">Status</th>
              <th className="py-3 px-3 font-medium">Follow-up</th>
              <th className="py-3 px-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 font-sans">
            {investors.map(inv => (
              <tr 
                key={inv.id}
                className="hover:bg-slate-100 transition-colors group cursor-pointer"
                onClick={() => onOpenInvestorDetail(inv)}
              >
                
                {/* Investor & Firm */}
                <td className="py-3 px-3.5">
                  <div className="font-semibold text-slate-900 group-hover:text-emerald-800 transition-colors">
                    {inv.name}
                  </div>
                  <div className="text-xs text-slate-500 flex items-center gap-1.5 mt-0.5">
                    <span>{inv.firm}</span>
                    <span className="text-slate-400">·</span>
                    <span className="text-slate-500">{inv.location}</span>
                  </div>
                </td>

                {/* Stage & Check */}
                <td className="py-3 px-3 whitespace-nowrap">
                  <div className="text-slate-700">{inv.stage}</div>
                  <div className="text-xs text-emerald-600 mt-0.5">
                    {inv.checkSizeFormatted}
                  </div>
                </td>

                {/* Fit Score */}
                <td className="py-3 px-3 whitespace-nowrap">
                  <div className="flex items-center gap-1.5">
                    <span className={` font-bold text-xs ${
                      inv.fitScore.status === 'hot' 
                        ? 'text-emerald-600' 
                        : inv.fitScore.status === 'warm' 
                        ? 'text-amber-600' 
                        : 'text-slate-500'
                    }`}>
                      {inv.fitScore.status === 'hot' ? '🔥' : inv.fitScore.status === 'warm' ? '⚡' : '❄️'} {inv.fitScore.total}%
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-500 truncate max-w-[130px]" title={inv.fitScore.verdict}>
                    {inv.fitScore.status}
                  </div>
                </td>

                {/* Portfolio */}
                <td className="py-3 px-3">
                  <div className="flex flex-wrap gap-1 max-w-xs">
                    {inv.portfolio.slice(0, 3).map((p, idx) => (
                      <span key={idx} className="text-[11px] px-1.5 py-0.2 rounded bg-slate-50 text-slate-700 border border-slate-200">
                        {p}
                      </span>
                    ))}
                    {inv.portfolio.length > 3 && (
                      <span className="text-[11px] text-slate-500">+{inv.portfolio.length - 3}</span>
                    )}
                  </div>
                </td>

                {/* Outreach Status Selector */}
                <td className="py-3 px-3" onClick={e => e.stopPropagation()}>
                  <select
                    value={inv.outreach.status}
                    onChange={e => onUpdateStatus(inv.id, e.target.value as OutreachStatus)}
                    className="bg-slate-50 border border-slate-200 rounded px-2 py-1 text-xs text-slate-800 focus:outline-none focus:border-emerald-400 cursor-pointer"
                  >
                    <option value="discovered">Discovered</option>
                    <option value="researched">Researched</option>
                    <option value="hot">🔥 Hot Lead</option>
                    <option value="warm">⚡ Warm Lead</option>
                    <option value="contacted">Contacted</option>
                    <option value="replied">Replied</option>
                    <option value="meeting">Meeting Booked</option>
                    <option value="diligence">Diligence</option>
                    <option value="passed">Passed</option>
                  </select>
                </td>

                {/* Follow-up Date */}
                <td className="py-3 px-3 whitespace-nowrap" onClick={e => e.stopPropagation()}>
                  <input
                    type="date"
                    value={inv.outreach.nextFollowUpDate || ''}
                    onChange={e => onUpdateFollowUp(inv.id, e.target.value)}
                    className="bg-transparent border border-transparent hover:border-slate-200 rounded px-1.5 py-0.5 text-xs text-slate-700 focus:bg-slate-100 focus:border-slate-300 focus:outline-none"
                  />
                </td>

                {/* Actions */}
                <td className="py-3 px-3.5 text-right whitespace-nowrap" onClick={e => e.stopPropagation()}>
                  <div className="flex items-center justify-end gap-1">
                    <button
                      onClick={() => onOpenInvestorDetail(inv)}
                      className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded transition-colors cursor-pointer"
                      title="Open full profile"
                    >
                      <Eye className="w-3.5 h-3.5" />
                    </button>

                    {inv.linkedin && (
                      <a
                        href={inv.linkedin}
                        target="_blank"
                        rel="noreferrer"
                        className="p-1.5 text-sky-600 hover:text-sky-800 hover:bg-sky-100 rounded transition-colors text-[11px] font-bold"
                        title="Open public LinkedIn profile"
                      >
                        in
                      </a>
                    )}
                    {inv.email && <a
                      href={`mailto:${inv.email}?subject=${encodeURIComponent(inv.outreach.sequences[0]?.subject || '')}&body=${encodeURIComponent(inv.outreach.sequences[0]?.body || '')}`}
                      className="p-1.5 text-emerald-600 hover:text-emerald-800 hover:bg-emerald-100 rounded transition-colors"
                      title="Send email via default client"
                    >
                      <Mail className="w-3.5 h-3.5" />
                    </a>}
                    {inv.phone && (
                      <a
                        href={`tel:${inv.phone.replace(/[^\d+]/g, '')}`}
                        className="px-1.5 py-1 text-[10px] font-semibold text-sky-700 hover:bg-sky-100 rounded transition-colors"
                        title={`Public phone: ${inv.phone}`}
                      >
                        ☎
                      </a>
                    )}

                    <button
                      onClick={() => onDeleteInvestor(inv.id)}
                      className="p-1.5 text-slate-500 hover:text-red-700 hover:bg-red-100 rounded transition-colors cursor-pointer"
                      title={`Delete ${T.one}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </td>

              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
