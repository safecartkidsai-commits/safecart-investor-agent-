import React, { useState } from 'react';
import { 
  Cpu, 
  Sparkles, 
  Check, 
  ShieldCheck, 
  ExternalLink, 
  RotateCw, 
  Copy, 
  Send,
  Zap,
  Building2,
  AlertTriangle
} from 'lucide-react';
import { Investor, StartupProfile, AppSettings } from '../types';
import { audienceOf, textFor } from '../data/audience';
import { api } from '../services/api';

interface AiScoringTabProps {
  investors: Investor[];
  startup: StartupProfile;
  settings: AppSettings;
  onUpdateInvestor: (updated: Investor) => void;
  onOpenInvestorDetail: (inv: Investor) => void;
  showToast: (msg: string, error?: boolean) => void;
}

export const AiScoringTab: React.FC<AiScoringTabProps> = ({
  investors,
  startup,
  settings,
  onUpdateInvestor,
  onOpenInvestorDetail,
  showToast
}) => {
  const T = textFor(audienceOf(settings));
  const [selectedInvestorId, setSelectedInvestorId] = useState<string>(investors[0]?.id || '');
  const [isScoring, setIsScoring] = useState(false);
  const [copiedAngle, setCopiedAngle] = useState(false);

  const selectedInvestor = investors.find(i => i.id === selectedInvestorId) || investors[0];

  const handleRunEvaluation = async () => {
    if (!selectedInvestor) return;
    setIsScoring(true);
    try {
      const result = await api.score(startup, selectedInvestor);
      const status = selectedInvestor.outreach.status;
      const autoStatus = ['discovered', 'researched', 'hot', 'warm'].includes(status);
      const updated: Investor = {
        ...selectedInvestor,
        fitScore: result.fitScore,
        researchNotes: result.researchNotes,
        outreach: {
          ...selectedInvestor.outreach,
          status: autoStatus ? (result.fitScore.status === 'cold' ? 'researched' : result.fitScore.status) : status
        },
        updatedAt: new Date().toISOString()
      };
      if (!updated.outreach.sequences?.length) {
        const o = await api.outreach(startup, updated, settings);
        updated.outreach = { ...updated.outreach, sequences: o.sequences, sequenceGenerated: true, templateV: o.templateV };
        updated.linkedinNote = o.linkedinNote;
        updated.linkedinMessage = o.linkedinMessage;
      }
      onUpdateInvestor(updated);
    } catch (e: any) {
      showToast(e?.message || 'Scoring failed', true);
    } finally {
      setIsScoring(false);
    }
  };

  const handleCopyTalkingPoint = () => {
    if (!selectedInvestor) return;
    navigator.clipboard.writeText(selectedInvestor.fitScore.keyTalkingPoint);
    setCopiedAngle(true);
    setTimeout(() => setCopiedAngle(false), 2000);
  };

  if (!selectedInvestor) {
    return (
      <div className="p-8 text-center text-slate-500">
        No {T.many} yet. Click "{T.find}" at the top to get started.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      
      {/* Header Banner */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">{T.One} scores</h1>
          <p className="text-sm text-slate-500 mt-0.5">How well each {T.one} fits {startup.name}.</p>
        </div>

        <button
          onClick={handleRunEvaluation}
          disabled={isScoring}
          className="flex items-center gap-1.5 px-3.5 py-2 bg-white border border-slate-300 hover:bg-slate-50 text-slate-800 text-sm font-semibold rounded-lg transition-colors cursor-pointer shrink-0 disabled:opacity-50"
        >
          <RotateCw className={`w-3.5 h-3.5 ${isScoring ? 'animate-spin' : ''}`} />
          <span>{isScoring ? 'Scoring…' : 'Re-score'}</span>
        </button>
      </div>

      {/* Main Layout: Investor Selector on Left, Deep Dive on Right */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        
        {/* Left Column: Investor List */}
        <div className="space-y-2 bg-white border border-slate-200 rounded-xl shadow-sm p-3 max-h-[700px] overflow-y-auto">
          <div className="text-xs font-semibold text-slate-500 px-2 uppercase tracking-wider mb-2">
            {T.Many} ({investors.length})
          </div>

          {[...investors].sort((a, b) => b.fitScore.total - a.fitScore.total).map(inv => (
            <div
              key={inv.id}
              onClick={() => setSelectedInvestorId(inv.id)}
              className={`p-3 rounded-lg border transition-all cursor-pointer text-xs ${
                selectedInvestorId === inv.id
                  ? 'bg-emerald-50 border-emerald-300 text-slate-900'
                  : 'bg-white border-slate-200 hover:bg-slate-50 text-slate-700'
              }`}
            >
              <div className="flex items-start justify-between gap-1">
                <span className="font-semibold">{inv.name}</span>
                <span className={`text-[11px] font-bold ${
                  inv.fitScore.status === 'hot' ? 'text-emerald-600' :
                  inv.fitScore.status === 'warm' ? 'text-amber-600' : 'text-slate-500'
                }`}>
                  {inv.fitScore.total}%
                </span>
              </div>
              <div className="text-xs text-slate-500 mt-0.5 truncate">
                {inv.firm} · {inv.location}
              </div>
              <div className="text-[11px] text-emerald-600 mt-1">
                {inv.checkSizeFormatted}
              </div>
            </div>
          ))}
        </div>

        {/* Right Column: Deep Dossier */}
        <div className="lg:col-span-2 space-y-4">
          
          {/* Target Investor Hero Card */}
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5 space-y-4">
            
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-4">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-bold text-slate-900 tracking-tight">{selectedInvestor.name}</h3>
                  <span className="text-xs text-slate-500">({selectedInvestor.title}, {selectedInvestor.firm})</span>
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  {T.field.stage}: <strong className="text-slate-800">{selectedInvestor.stage}</strong> · {T.field.check}: <strong className="text-emerald-600">{selectedInvestor.checkSizeFormatted}</strong>
                </div>
              </div>

              {/* Total Score Display */}
              <div className="flex items-center gap-2 shrink-0 bg-white px-3.5 py-2 rounded-lg border border-slate-200">
                <span className="text-xl">
                  {selectedInvestor.fitScore.status === 'hot' ? '🔥' : selectedInvestor.fitScore.status === 'warm' ? '⚡' : '❄️'}
                </span>
                <div>
                  <div className="text-xs font-semibold text-slate-500">Fit score</div>
                  <div className="text-xl font-bold text-slate-900 leading-none">
                    {selectedInvestor.fitScore.total}%
                  </div>
                </div>
              </div>
            </div>

            {/* Radar / Subscore meters */}
            <div>
              <div className="text-xs font-semibold text-slate-700 mb-2">Match breakdown</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-center">
                
                <div className="bg-white p-2.5 rounded border border-slate-200">
                  <div className="text-[11px] text-slate-500 uppercase">{T.fit.thesis}</div>
                  <div className="text-base font-bold text-slate-900 mt-0.5">{selectedInvestor.fitScore.thesisMatch}%</div>
                  <div className="w-full bg-slate-100 rounded-full h-1 mt-1.5 overflow-hidden">
                    <div className="bg-cyan-600 h-1" style={{ width: `${selectedInvestor.fitScore.thesisMatch}%` }} />
                  </div>
                </div>

                <div className="bg-white p-2.5 rounded border border-slate-200">
                  <div className="text-[11px] text-slate-500 uppercase">{T.fit.stage}</div>
                  <div className="text-base font-bold text-slate-900 mt-0.5">{selectedInvestor.fitScore.stageMatch}%</div>
                  <div className="w-full bg-slate-100 rounded-full h-1 mt-1.5 overflow-hidden">
                    <div className="bg-emerald-600 h-1" style={{ width: `${selectedInvestor.fitScore.stageMatch}%` }} />
                  </div>
                </div>

                <div className="bg-white p-2.5 rounded border border-slate-200">
                  <div className="text-[11px] text-slate-500 uppercase">{T.fit.sector}</div>
                  <div className="text-base font-bold text-slate-900 mt-0.5">{selectedInvestor.fitScore.sectorMatch}%</div>
                  <div className="w-full bg-slate-100 rounded-full h-1 mt-1.5 overflow-hidden">
                    <div className="bg-amber-600 h-1" style={{ width: `${selectedInvestor.fitScore.sectorMatch}%` }} />
                  </div>
                </div>

                <div className="bg-white p-2.5 rounded border border-slate-200">
                  <div className="text-[11px] text-slate-500 uppercase">{T.fit.synergy}</div>
                  <div className="text-base font-bold text-slate-900 mt-0.5">{selectedInvestor.fitScore.synergyMatch}%</div>
                  <div className="w-full bg-slate-100 rounded-full h-1 mt-1.5 overflow-hidden">
                    <div className="bg-purple-600 h-1" style={{ width: `${selectedInvestor.fitScore.synergyMatch}%` }} />
                  </div>
                </div>

              </div>
            </div>

            {/* Verdict */}
            <div className="p-3 rounded bg-white border border-slate-200 text-xs italic text-slate-700">
              "{selectedInvestor.fitScore.verdict}"
            </div>

            {/* Why They'll Invest vs Hesitations */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                <span className="font-semibold text-emerald-600 flex items-center gap-1.5 mb-2">
                  <Check className="w-3.5 h-3.5" /> {T.field.why}
                </span>
                <ul className="space-y-1.5 text-slate-700 text-xs">
                  {selectedInvestor.fitScore.whyInvest.map((w, idx) => (
                    <li key={idx} className="flex items-start gap-1.5">
                      <span className="text-emerald-600 font-bold shrink-0">·</span>
                      <span>{w}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                <span className="font-semibold text-amber-600 flex items-center gap-1.5 mb-2">
                  <AlertTriangle className="w-3.5 h-3.5" /> Possible concerns
                </span>
                <ul className="space-y-1.5 text-slate-700 text-xs">
                  {selectedInvestor.fitScore.hesitations.map((h, idx) => (
                    <li key={idx} className="flex items-start gap-1.5">
                      <span className="text-amber-600 font-bold shrink-0">·</span>
                      <span>{h}</span>
                    </li>
                  ))}
                </ul>
              </div>

            </div>

            {/* Psychological Angle */}
            <div className="p-3.5 rounded-lg bg-white border border-slate-200">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] uppercase font-bold text-slate-500 tracking-wider">
                  Best way to open
                </span>
                <button
                  onClick={handleCopyTalkingPoint}
                  className="text-[11px] text-slate-500 hover:text-slate-900 flex items-center gap-1 transition-colors cursor-pointer"
                >
                  {copiedAngle ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                  <span>{copiedAngle ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
              <div className="text-xs text-slate-900 font-medium">
                {selectedInvestor.fitScore.keyTalkingPoint}
              </div>
            </div>

            {/* Quick Action Button */}
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-200 text-xs">
              <button
                onClick={() => onOpenInvestorDetail(selectedInvestor)}
                className="px-3.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-900 rounded font-medium transition-colors cursor-pointer"
              >
                Open full dossier
              </button>
            </div>

          </div>

        </div>

      </div>

    </div>
  );
};
