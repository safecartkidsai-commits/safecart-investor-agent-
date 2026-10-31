import React, { useEffect, useMemo, useState } from 'react';
import { Mail, Send, Copy, Check, RotateCw, CheckCircle2, AlertCircle, FileSpreadsheet, Clock, Linkedin, MessageSquareReply, Loader2, CalendarClock, ExternalLink, Zap, Pause, Play, Search } from 'lucide-react';
import { Investor, StartupProfile, AppSettings, HealthInfo, AutomationStatus } from '../types';
import { audienceOf, textFor } from '../data/audience';
import { openInGoogleSheets } from '../services/sheets';

/** Coloured "Investor" / "Fundraising Expert" tag — same words as the Gmail label on the email thread. */
const TagChip: React.FC<{ label: string }> = ({ label }) => (
  <span
    className={`inline-block px-1.5 py-px rounded text-[10px] font-bold uppercase tracking-wide ${
      label === 'Investor' ? 'bg-indigo-100 text-indigo-700' : 'bg-amber-100 text-amber-800'
    }`}
  >
    {label}
  </span>
);
/** Activity lines start with "[Investor]" / "[Fundraising Expert]" — show that as a chip. */
const withTag = (msg: string) => {
  const m = msg.match(/^\[(Investor|Fundraising Expert)\]\s*/);
  return m ? (
    <>
      <TagChip label={m[1]} /> {msg.slice(m[0].length)}
    </>
  ) : (
    msg
  );
};
import { api, gmailComposeUrl, mailtoUrl, linkedinSearchUrl, addDays, todayIso } from '../services/api';

interface Props {
  investors: Investor[];
  startup: StartupProfile;
  settings: AppSettings;
  health: HealthInfo | null;
  onUpdateInvestor: (updated: Investor, quiet?: boolean) => void;
  onOpenInvestorDetail: (inv: Investor) => void;
  showToast: (msg: string, error?: boolean) => void;
}

type Filter = 'due' | 'ready' | 'linkedin' | 'accepted' | 'contacted' | 'all';
const CLOSED = ['replied', 'meeting', 'diligence', 'passed'];

export const MauticCampaignsTab: React.FC<Props> = ({ investors, startup, settings, health, onUpdateInvestor, onOpenInvestorDetail, showToast }) => {
  const T = textFor(audienceOf(settings));
  const today = todayIso();
  const isDue = (i: Investor) => !!i.outreach.nextFollowUpDate && i.outreach.nextFollowUpDate <= today && !CLOSED.includes(i.outreach.status);
  const isReady = (i: Investor) => i.outreach.sentStepsCount === 0 && !i.outreach.linkedinRequestSentAt && !CLOSED.includes(i.outreach.status) && i.fitScore.status !== 'cold';
  // LinkedIn: a daily to-do list (LinkedIn allows ~100-200 requests/week, so we pace it)
  const requestedToday = investors.filter(i => (i.outreach.linkedinRequestSentAt || '').slice(0, 10) === today).length;
  const linkedinLeft = Math.max(0, (settings.linkedinDailyLimit || 20) - requestedToday);
  const linkedinQueue = investors
    .filter(i => i.linkedin && !i.outreach.linkedinRequestSentAt && !CLOSED.includes(i.outreach.status) && i.fitScore.status !== 'cold')
    .sort((a, b) => b.fitScore.total - a.fitScore.total)
    .slice(0, linkedinLeft);
  const isAccepted = (i: Investor) => !!i.outreach.linkedinAcceptedAt && !i.outreach.linkedinMessagedAt && !CLOSED.includes(i.outreach.status);
  const counts = {
    due: investors.filter(isDue).length,
    ready: investors.filter(isReady).length,
    linkedin: linkedinQueue.length,
    accepted: investors.filter(isAccepted).length,
    contacted: investors.filter(i => i.outreach.sentStepsCount > 0 || !!i.outreach.linkedinRequestSentAt).length,
    all: investors.length
  };
  const [filter, setFilter] = useState<Filter>(counts.accepted ? 'accepted' : counts.due ? 'due' : 'ready');
  const list = useMemo(() => {
    if (filter === 'linkedin') return linkedinQueue;
    const l = investors.filter(i =>
      filter === 'due'
        ? isDue(i)
        : filter === 'ready'
        ? isReady(i)
        : filter === 'accepted'
        ? isAccepted(i)
        : filter === 'contacted'
        ? i.outreach.sentStepsCount > 0 || !!i.outreach.linkedinRequestSentAt
        : true
    );
    return l.sort((a, b) => b.fitScore.total - a.fitScore.total);
  }, [investors, filter, linkedinLeft]); // eslint-disable-line react-hooks/exhaustive-deps

  // automatic email status (server-side autopilot)
  const [auto, setAuto] = useState<AutomationStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [researching, setResearching] = useState(false);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [manualEmail, setManualEmail] = useState('');
  useEffect(() => {
    let alive = true;
    const load = () => api.automationStatus().then(r => alive && setAuto(r)).catch(() => {});
    load();
    const t = window.setInterval(load, 30000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);
  const checkNow = async () => {
    setChecking(true);
    try {
      setAuto(await api.runAutomation());
    } catch (e: any) {
      showToast(e?.message || 'Check failed', true);
    } finally {
      setChecking(false);
    }
  };

  const [selectedId, setSelectedId] = useState<string>('');
  const selected = investors.find(i => i.id === selectedId) || list[0];
  const sequences = selected?.outreach.sequences || [];
  const nextStepNumber = Math.min((selected?.outreach.sentStepsCount || 0) + 1, Math.max(sequences.length, 1));
  const [activeStep, setActiveStep] = useState(nextStepNumber);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [copied, setCopied] = useState('');
  const [busy, setBusy] = useState<'' | 'regen' | 'send'>('');

  useEffect(() => {
    setActiveStep(nextStepNumber);
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const step = sequences.find(s => s.stepNumber === activeStep) || sequences[0];
  useEffect(() => {
    setSubject(step?.subject || '');
    setBody(step?.body || '');
  }, [selected?.id, step?.stepNumber, step?.subject, step?.body]);

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(''), 1800);
  };

  const edited = !!step && (subject !== step.subject || body !== step.body);
  const saveEdits = () => {
    if (!selected || !step) return;
    onUpdateInvestor({
      ...selected,
      outreach: { ...selected.outreach, sequences: sequences.map(s => (s.stepNumber === step.stepNumber ? { ...s, subject, body } : s)) }
    });
  };

  const markSent = (via: string) => {
    if (!selected || !step) return;
    const idx = sequences.findIndex(s => s.stepNumber === step.stepNumber);
    const next = sequences[idx + 1];
    const nextDate = next ? addDays(today, Math.max(1, next.dayDelay - step.dayDelay)) : '';
    onUpdateInvestor(
      {
        ...selected,
        outreach: {
          ...selected.outreach,
          sequences: sequences.map(s => (s.stepNumber === step.stepNumber ? { ...s, subject, body, sentAt: new Date().toISOString() } : s)),
          status: CLOSED.includes(selected.outreach.status) ? selected.outreach.status : 'contacted',
          sentStepsCount: Math.max(selected.outreach.sentStepsCount, step.stepNumber),
          lastContactedDate: today,
          nextFollowUpDate: nextDate
        }
      },
      true
    );
    showToast(next ? `Step ${step.stepNumber} marked sent${via}. Next follow-up scheduled for ${nextDate}.` : `Final step sent${via}. Sequence complete.`);
    if (next) setActiveStep(next.stepNumber);
  };

  const sendViaServer = async () => {
    if (!selected?.email || !step) return;
    setBusy('send');
    try {
      const r = await api.sendEmail(selected.email, subject, body, startup.founderEmail || settings.senderEmail || undefined, undefined, textFor(audienceOf(selected)).label);
      if (!r.ok) throw new Error(r.error);
      markSent(' via Brevo');
    } catch (e: any) {
      showToast(e?.message || 'Send failed', true);
    } finally {
      setBusy('');
    }
  };

  const markReplied = () => {
    if (!selected) return;
    onUpdateInvestor({ ...selected, outreach: { ...selected.outreach, status: 'replied', replyDate: today, nextFollowUpDate: '' } });
  };

  const markLinkedInSent = () => {
    if (!selected) return;
    onUpdateInvestor({
      ...selected,
      outreach: {
        ...selected.outreach,
        linkedinRequestSentAt: new Date().toISOString(),
        status: CLOSED.includes(selected.outreach.status) ? selected.outreach.status : 'contacted',
        lastContactedDate: today,
        nextFollowUpDate: selected.outreach.nextFollowUpDate || addDays(today, 5)
      }
    });
  };

  const markAccepted = () => {
    if (!selected) return;
    onUpdateInvestor({ ...selected, outreach: { ...selected.outreach, linkedinAcceptedAt: new Date().toISOString() } }, true);
  };

  const markMessaged = () => {
    if (!selected) return;
    onUpdateInvestor({ ...selected, outreach: { ...selected.outreach, linkedinMessagedAt: new Date().toISOString(), lastContactedDate: today } });
  };

  const openAndCopy = (url: string, text: string, key: string) => {
    if (text) copy(text, key);
    window.open(url, '_blank', 'noopener');
  };

  const toggleAutoPause = () => {
    if (!selected) return;
    onUpdateInvestor({ ...selected, outreach: { ...selected.outreach, autoPaused: !selected.outreach.autoPaused } }, true);
  };

  const saveManualEmail = () => {
    if (!selected) return;
    const e = manualEmail.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e)) {
      showToast('That does not look like an email address', true);
      return;
    }
    onUpdateInvestor({ ...selected, email: e, contactRoute: 'Email', updatedAt: new Date().toISOString() }, true);
    setManualEmail('');
    showToast(`Saved ${e} for ${selected.name}`);
  };

  const researchDeeply = async () => {
    if (!selected) return;
    setResearching(true);
    try {
      const { investor } = await api.researchInvestor(startup, selected, settings);
      onUpdateInvestor(investor, true);
      showToast(`${investor.name} researched — fit ${investor.fitScore.total}/100${investor.email ? ` · email: ${investor.email}` : ' · still no public email'}`);
    } catch (e: any) {
      showToast(e?.message || 'Research failed', true);
    } finally {
      setResearching(false);
    }
  };

  const regenerate = async () => {
    if (!selected) return;
    setBusy('regen');
    try {
      const o = await api.outreach(startup, selected, settings);
      onUpdateInvestor({
        ...selected,
        linkedinNote: o.linkedinNote,
        linkedinMessage: o.linkedinMessage,
        outreach: {
          ...selected.outreach,
          sequenceGenerated: true,
          templateV: o.templateV,
          sequences: o.sequences.map(s => ({ ...s, sentAt: sequences.find(x => x.stepNumber === s.stepNumber)?.sentAt }))
        }
      });
    } catch (e: any) {
      showToast(e?.message || 'AI rewrite failed', true);
    } finally {
      setBusy('');
    }
  };

  const spamWords = ['guarantee', 'free', '100%', 'risk-free', 'buy now', 'urgent', 'winner', 'millionaire', '$$$'];
  const spam = spamWords.filter(w => `${subject} ${body}`.toLowerCase().includes(w));
  const words = body.split(/\s+/).filter(Boolean).length;
  const note = selected?.linkedinNote || '';

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Outreach</h1>
          <p className="text-sm text-slate-500 mt-0.5">Send messages and keep track of follow-ups.</p>
        </div>
        <button
          onClick={async () => {
            setSheetBusy(true);
            await openInGoogleSheets(audienceOf(settings), showToast);
            setSheetBusy(false);
          }}
          disabled={sheetBusy}
          title="Create a Google Sheet of this list in your Google Drive and open it"
          className="flex items-center gap-1.5 px-3.5 py-2 bg-white border border-slate-300 hover:bg-slate-50 text-slate-800 text-sm font-semibold rounded-lg cursor-pointer shrink-0 disabled:opacity-60"
        >
          <FileSpreadsheet className="w-3.5 h-3.5" /> {sheetBusy ? 'Creating sheet…' : 'Open in Google Sheets'}
        </button>
      </div>

      {auto && (
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 text-sm space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-semibold text-slate-900">
              <Zap className={`w-4 h-4 ${auto.autoEmailEnabled && auto.emailProvider === 'gmail' ? 'text-emerald-600' : 'text-slate-400'}`} />
              Automatic email:{' '}
              {auto.autoEmailEnabled ? (
                auto.emailProvider === 'none' ? (
                  <span className="text-amber-700 font-medium">on, but no Gmail helper connected</span>
                ) : (
                  <span className="text-emerald-700 font-medium">on</span>
                )
              ) : (
                <span className="text-slate-500 font-medium">off (turn on in Settings)</span>
              )}
            </div>
            <button
              onClick={checkNow}
              disabled={checking}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-xs font-medium cursor-pointer disabled:opacity-50"
            >
              {checking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCw className="w-3.5 h-3.5" />} Check replies & send now
            </button>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-600">
            <span>
              Sent today: <b className="text-slate-900">{auto.sentToday}</b> / {auto.dailyLimit}
            </span>
            <span>
              Waiting to send: <b className="text-slate-900">{auto.queued}</b>
            </span>
            {auto.gmailRemaining !== undefined && <span>Gmail allowance left today: {auto.gmailRemaining}</span>}
            {auto.lastCheckAt && <span>Inbox checked {new Date(auto.lastCheckAt).toLocaleTimeString()}</span>}
          </div>
          {auto.lastError && <div className="text-xs text-red-600">{auto.lastError}</div>}
          {auto.recent.length > 0 && (
            <details className="text-xs text-slate-600">
              <summary className="cursor-pointer">Recent activity</summary>
              <ul className="mt-1 space-y-0.5 max-h-40 overflow-y-auto">
                {auto.recent.map((r, k) => (
                  <li key={k} className={r.level === 'error' ? 'text-red-600' : r.level === 'warn' ? 'text-amber-700' : r.level === 'success' ? 'text-emerald-700' : ''}>
                    {new Date(r.at).toLocaleString()} — {withTag(r.message)}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-3 max-h-[760px] overflow-y-auto space-y-2">
          <div className="grid grid-cols-3 gap-1 text-[11px] mb-2">
            {(
              [
                ['accepted', `Accepted ${counts.accepted}`],
                ['linkedin', `LinkedIn today ${counts.linkedin}`],
                ['due', `Due ${counts.due}`],
                ['ready', `New ${counts.ready}`],
                ['contacted', `Sent ${counts.contacted}`],
                ['all', `All ${counts.all}`]
              ] as const
            ).map(([id, t]) => (
              <button
                key={id}
                onClick={() => setFilter(id)}
                className={`px-1.5 py-1.5 rounded border cursor-pointer ${filter === id ? 'bg-emerald-50 border-emerald-300 text-emerald-800' : 'border-slate-200 text-slate-500 hover:text-slate-900'}`}
              >
                {t}
              </button>
            ))}
          </div>
          {list.length === 0 && (
            <div className="text-xs text-slate-500 p-4 text-center">
              {filter === 'due'
                ? 'No follow-ups due today 🎉'
                : filter === 'linkedin'
                ? linkedinLeft === 0
                  ? `You've sent ${requestedToday} LinkedIn requests today — that's the daily limit. Come back tomorrow.`
                  : 'No one left with a LinkedIn profile to invite.'
                : filter === 'accepted'
                ? 'No new acceptances yet. They appear here automatically when LinkedIn emails you.'
                : investors.length
                ? 'Nothing in this list.'
                : `No ${T.many} yet — run the agent first.`}
            </div>
          )}
          {list.map(inv => (
            <div
              key={inv.id}
              onClick={() => setSelectedId(inv.id)}
              className={`p-3 rounded-lg border cursor-pointer text-xs ${
                selected?.id === inv.id ? 'bg-emerald-50 border-emerald-300 text-slate-900' : 'bg-white border-slate-200 hover:bg-slate-50 text-slate-700'
              }`}
            >
              <div className="flex items-start justify-between gap-1">
                <span className="font-semibold truncate">{inv.name}</span>
                <span className={`text-[11px] font-bold ${inv.fitScore.status === 'hot' ? 'text-emerald-600' : inv.fitScore.status === 'warm' ? 'text-amber-600' : 'text-slate-500'}`}>
                  {inv.fitScore.total}
                </span>
              </div>
              <div className="text-xs text-slate-500 mt-0.5 truncate">{inv.firm}</div>
              <div className="flex items-center gap-2 mt-1 text-[11px]">
                <span className="px-1.5 rounded bg-slate-100 text-purple-700">{inv.outreach.status}</span>
                {inv.researchDepth === 'quick' && <span className="px-1.5 rounded bg-slate-100 text-slate-500">quick scan</span>}
                {isAccepted(inv) && <span className="px-1.5 rounded bg-sky-100 text-sky-700">accepted</span>}
                {inv.outreach.status === 'replied' && <TagChip label={textFor(audienceOf(inv)).label} />}
                {inv.outreach.sentStepsCount > 0 && <span className="text-slate-500">{inv.outreach.sentStepsCount}/{inv.outreach.sequences.length} sent</span>}
                {inv.outreach.nextFollowUpDate && !CLOSED.includes(inv.outreach.status) && (
                  <span className={isDue(inv) ? 'text-amber-700' : 'text-slate-500'}>next {inv.outreach.nextFollowUpDate}</span>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="lg:col-span-2 space-y-4">
          {!selected ? (
            <div className="p-8 text-center text-slate-500 text-sm border border-slate-200 rounded-xl shadow-sm">Select an investor.</div>
          ) : (
            <>
              <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-base font-bold text-slate-900">{selected.name}</h3>
                    <TagChip label={textFor(audienceOf(selected)).label} />
                    <span className="text-xs text-slate-500">{selected.firm}</span>
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5 truncate">
                    {selected.email || 'no public email found'}
                    {selected.phone ? ` · ☎ ${selected.phone}` : ''} · {selected.contactRoute}
                  </div>
                  {selected.email && selected.researchDepth !== 'quick' && settings.autoEmailEnabled && selected.fitScore.total >= settings.autoEmailMinScore && (
                    <button onClick={toggleAutoPause} className="mt-1.5 flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 cursor-pointer">
                      {selected.outreach.autoPaused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
                      {selected.outreach.autoPaused ? `Auto-email paused for this ${T.one} — resume` : `Auto-email on for this ${T.one} — pause`}
                    </button>
                  )}
                  {selected.outreach.autoError && <div className="mt-1 text-xs text-red-600">Last auto-email failed: {selected.outreach.autoError}</div>}
                </div>
                <div className="flex gap-2 flex-wrap">
                  {selected.researchDepth === 'quick' && (
                    <button
                      onClick={researchDeeply}
                      disabled={researching}
                      className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs rounded cursor-pointer disabled:opacity-50"
                    >
                      {researching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />} Research deeply
                    </button>
                  )}
                  <button onClick={markReplied} className="flex items-center gap-1 px-3 py-1.5 bg-emerald-100 hover:bg-emerald-200 text-emerald-900 text-xs rounded cursor-pointer">
                    <MessageSquareReply className="w-3.5 h-3.5" /> They replied
                  </button>
                  <button
                    onClick={regenerate}
                    disabled={busy === 'regen'}
                    className="flex items-center gap-1 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs rounded cursor-pointer disabled:opacity-50"
                  >
                    <RotateCw className={`w-3.5 h-3.5 ${busy === 'regen' ? 'animate-spin' : ''}`} /> Rewrite with AI
                  </button>
                </div>
              </div>

              {/* LinkedIn */}
              <div className="bg-sky-50 border border-sky-200 rounded-xl shadow-sm p-4 space-y-2 text-xs">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="font-semibold text-sky-700 flex items-center gap-1.5">
                    <Linkedin className="w-4 h-4" /> LinkedIn connection note
                    <span className={` text-[11px] ${note.length > 300 ? 'text-red-600' : 'text-slate-500'}`}>{note.length}/300</span>
                  </span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => openAndCopy(selected.linkedin || linkedinSearchUrl(selected.name, selected.firm), selected.outreach.linkedinAcceptedAt ? '' : note, 'li')}
                      className="flex items-center gap-1 px-2.5 py-1 rounded bg-sky-600 hover:bg-sky-700 text-white cursor-pointer"
                      title="Opens their profile and copies the note"
                    >
                      {selected.linkedin ? 'Open profile' : 'Find on LinkedIn'} <ExternalLink className="w-3 h-3" />
                    </button>
                    <button onClick={() => copy(note, 'li')} disabled={!note} className="flex items-center gap-1 px-2.5 py-1 rounded bg-slate-100 hover:bg-slate-200 cursor-pointer disabled:opacity-40">
                      {copied === 'li' ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />} Copy note
                    </button>
                    {selected.outreach.linkedinAcceptedAt ? (
                      <span className="flex items-center gap-1 text-emerald-600">
                        <CheckCircle2 className="w-3.5 h-3.5" /> accepted
                      </span>
                    ) : selected.outreach.linkedinRequestSentAt ? (
                      <>
                        <span className="flex items-center gap-1 text-emerald-600">
                          <CheckCircle2 className="w-3.5 h-3.5" /> request sent
                        </span>
                        <button onClick={markAccepted} className="px-2.5 py-1 rounded bg-slate-100 hover:bg-slate-200 cursor-pointer">
                          Mark accepted
                        </button>
                      </>
                    ) : (
                      <button onClick={markLinkedInSent} className="px-2.5 py-1 rounded bg-slate-100 hover:bg-slate-200 cursor-pointer">
                        Mark request sent
                      </button>
                    )}
                  </div>
                </div>
                <p className="text-slate-800 whitespace-pre-wrap">{note || 'No note yet — click "Rewrite with AI".'}</p>
                {selected.outreach.linkedinAcceptedAt && !selected.outreach.linkedinMessagedAt && (
                  <div className="p-3 rounded-lg bg-white border border-sky-200 space-y-2">
                    <div className="font-semibold text-sky-800">They accepted — send this message:</div>
                    <p className="text-slate-800 whitespace-pre-wrap">{selected.linkedinMessage || 'No message yet — click "Rewrite with AI".'}</p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => openAndCopy(selected.linkedin || linkedinSearchUrl(selected.name, selected.firm), selected.linkedinMessage || '', 'dm2')}
                        className="flex items-center gap-1 px-2.5 py-1 rounded bg-sky-600 hover:bg-sky-700 text-white cursor-pointer"
                      >
                        {copied === 'dm2' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />} Open profile & copy message
                      </button>
                      <button onClick={markMessaged} className="px-2.5 py-1 rounded bg-slate-100 hover:bg-slate-200 cursor-pointer">
                        Mark messaged
                      </button>
                    </div>
                  </div>
                )}
                {selected.outreach.linkedinMessagedAt && <div className="text-emerald-700">LinkedIn message sent {selected.outreach.linkedinMessagedAt.slice(0, 10)}.</div>}
                {selected.linkedinMessage && !selected.outreach.linkedinAcceptedAt && (
                  <details className="text-slate-500">
                    <summary className="cursor-pointer text-xs">Message to send after they accept</summary>
                    <div className="mt-1 flex items-start gap-2">
                      <p className="text-slate-700 whitespace-pre-wrap flex-1">{selected.linkedinMessage}</p>
                      <button onClick={() => copy(selected.linkedinMessage!, 'dm')} className="p-1 rounded hover:bg-slate-100 cursor-pointer">
                        {copied === 'dm' ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                      </button>
                    </div>
                  </details>
                )}
              </div>

              {/* Email cadence */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                {sequences.map(s => (
                  <button
                    key={s.stepNumber}
                    onClick={() => setActiveStep(s.stepNumber)}
                    className={`p-3 rounded-lg border text-left cursor-pointer ${
                      activeStep === s.stepNumber ? 'bg-emerald-50 border-emerald-300 text-slate-900' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-100'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] uppercase font-bold text-emerald-700">Email {s.stepNumber}</span>
                      {s.sentAt ? (
                        <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                      ) : (
                        <span className="text-[11px] text-slate-500 flex items-center gap-0.5">
                          <Clock className="w-2.5 h-2.5" /> day {s.dayDelay}
                        </span>
                      )}
                    </div>
                    <div className="font-semibold text-xs mt-1 truncate">{s.stepName}</div>
                  </button>
                ))}
              </div>

              {step ? (
                <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 sm:p-5 space-y-3">
                  <div>
                    <div className="text-[11px] text-slate-500 uppercase tracking-wider mb-1">Subject</div>
                    <input
                      value={subject}
                      onChange={e => setSubject(e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs font-semibold text-slate-900 focus:outline-none focus:border-purple-400"
                    />
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-500 uppercase tracking-wider mb-1">Message</div>
                    <textarea
                      rows={11}
                      value={body}
                      onChange={e => setBody(e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded-lg p-3 text-xs text-slate-800 leading-relaxed focus:outline-none focus:border-purple-400"
                    />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <div className="bg-white p-3 rounded-lg border border-slate-200">
                      <span className="text-slate-500 block text-[11px] uppercase font-bold mb-1">Why this works</span>
                      <p className="text-xs text-slate-700 italic">{step.rationale || '—'}</p>
                    </div>
                    <div className="bg-white p-3 rounded-lg border border-slate-200 space-y-1 text-xs">
                      <span className="text-slate-500 block text-[11px] uppercase font-bold">Deliverability</span>
                      <div className={`flex items-center gap-1.5 ${words <= 170 ? 'text-emerald-600' : 'text-amber-600'}`}>
                        <CheckCircle2 className="w-3.5 h-3.5" /> {words} words (ideal 75-150)
                      </div>
                      {spam.length === 0 ? (
                        <div className="flex items-center gap-1.5 text-emerald-600">
                          <CheckCircle2 className="w-3.5 h-3.5" /> No spam trigger words
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5 text-amber-600">
                          <AlertCircle className="w-3.5 h-3.5" /> Contains "{spam.join(', ')}"
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-3 border-t border-slate-200">
                    <div className="flex gap-2 flex-wrap">
                      <button onClick={() => copy(`Subject: ${subject}\n\n${body}`, 'email')} className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs rounded cursor-pointer">
                        {copied === 'email' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />} Copy
                      </button>
                      {edited && (
                        <button onClick={saveEdits} className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-amber-800 text-xs rounded cursor-pointer">
                          Save edits
                        </button>
                      )}
                    </div>
                    <div className="flex gap-2 flex-wrap">
                      <a
                        href={gmailComposeUrl(selected.email, subject, body)}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 hover:bg-slate-800 text-white font-semibold text-xs rounded"
                      >
                        <Mail className="w-3.5 h-3.5" /> Open in Gmail
                      </a>
                      <a href={mailtoUrl(selected.email, subject, body)} className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs rounded">
                        Mail app
                      </a>
                      {health?.email.configured && selected.email && (
                        <button
                          onClick={sendViaServer}
                          disabled={busy === 'send'}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-xs rounded cursor-pointer disabled:opacity-50"
                        >
                          {busy === 'send' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />} Send now
                        </button>
                      )}
                      <button
                        onClick={() => markSent('')}
                        disabled={!!step.sentAt}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-xs rounded cursor-pointer disabled:opacity-40"
                      >
                        <CalendarClock className="w-3.5 h-3.5" /> {step.sentAt ? 'Sent' : 'Mark as sent'}
                      </button>
                    </div>
                  </div>
                  {!selected.email && (
                    <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-2">
                      {selected.researchDepth === 'quick' ? (
                        <p>
                          <b>Not researched yet</b> — quick-scanned {T.many} haven't had their website checked, so there's no email yet.
                        </p>
                      ) : (selected.emailSearchV || 0) < 2 ? (
                        <p>
                          <b>Checked with the old email finder.</b> The new one also reads contact pages, hidden emails and the web — look again.
                        </p>
                      ) : (
                        <p>
                          <b>This {T.one} doesn't publish an email.</b> Many don't. Use the LinkedIn note above
                          {selected.website ? (
                            <>
                              , or the contact / pitch form on{' '}
                              <a href={selected.website} target="_blank" rel="noreferrer" className="underline">
                                their website
                              </a>
                            </>
                          ) : null}
                          . If you find an email yourself, add it in the full dossier.
                        </p>
                      )}
                      {(selected.researchDepth === 'quick' || (selected.emailSearchV || 0) < 2) && (
                        <button
                          onClick={researchDeeply}
                          disabled={researching}
                          className="px-3 py-1.5 rounded-md bg-amber-600 hover:bg-amber-700 disabled:opacity-60 text-white font-semibold cursor-pointer"
                        >
                          {researching ? 'Looking… (about a minute)' : selected.researchDepth === 'quick' ? 'Research deeply & find email' : 'Look again for an email'}
                        </button>
                      )}
                      <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-amber-200">
                        {selected.website && (
                          <a
                            href={`https://hunter.io/search/${(() => {
                              try {
                                return new URL(selected.website).hostname.replace(/^www\./, '');
                              } catch {
                                return '';
                              }
                            })()}`}
                            target="_blank"
                            rel="noreferrer"
                            className="px-2.5 py-1 rounded-md border border-amber-300 bg-white hover:bg-amber-100 text-amber-900 font-medium"
                          >
                            Look up on Hunter.io (free)
                          </a>
                        )}
                        <input
                          value={manualEmail}
                          onChange={e => setManualEmail(e.target.value)}
                          placeholder="Paste an email you found"
                          className="flex-1 min-w-[180px] bg-white border border-amber-300 rounded-md px-2 py-1 text-slate-900 focus:outline-none focus:border-amber-500"
                        />
                        <button
                          onClick={saveManualEmail}
                          className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-900 text-white font-medium cursor-pointer"
                        >
                          Save email
                        </button>
                      </div>
                      <p className="text-amber-700">Tip: to do many at once, click {T.find} → "Research the ones I already have".</p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-8 text-center text-slate-500 text-sm border border-slate-200 rounded-xl shadow-sm">
                  No emails drafted yet. Click "Rewrite with AI".
                </div>
              )}

              <div className="flex justify-end">
                <button onClick={() => onOpenInvestorDetail(selected)} className="text-xs text-slate-500 hover:text-slate-900 cursor-pointer">
                  Open full dossier →
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
