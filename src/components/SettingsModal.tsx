import React, { useEffect, useState } from 'react';
import { X, Settings, Check, RefreshCw, Cpu, Search, Mail, Database, CheckCircle2, AlertCircle } from 'lucide-react';
import { AppSettings, HealthInfo } from '../types';
import { api } from '../services/api';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  health: HealthInfo | null;
  onSaveSettings: (settings: AppSettings) => void;
  onClearCrm: () => void;
  onRefreshHealth: () => void;
}

const Row = ({ ok, icon, title, detail, hint }: { ok: boolean; icon: React.ReactNode; title: string; detail: string; hint?: string }) => (
  <div className="flex items-start gap-3 p-3 rounded-lg bg-slate-50 border border-slate-200">
    <div className="mt-0.5">{icon}</div>
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-1.5 font-medium text-slate-800">
        {ok ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> : <AlertCircle className="w-3.5 h-3.5 text-amber-600" />}
        {title}
      </div>
      <div className="text-xs text-slate-500 mt-0.5 break-words">{detail}</div>
      {hint && <div className="text-xs text-slate-500 mt-1">{hint}</div>}
    </div>
  </div>
);

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose, settings, health, onSaveSettings, onClearCrm, onRefreshHealth }) => {
  const [form, setForm] = useState<AppSettings>({ ...settings });
  const [test, setTest] = useState<{ busy?: boolean; ok?: boolean; message?: string }>({});
  useEffect(() => setForm({ ...settings }), [settings, isOpen]);
  if (!isOpen) return null;

  const field = 'w-full bg-slate-50 border border-slate-200 rounded px-2.5 py-1.5 text-slate-900 text-xs focus:outline-none focus:border-emerald-400';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/30 backdrop-blur-sm overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-xl max-w-2xl w-full p-6 text-slate-800 shadow-2xl my-8">
        <div className="flex items-center justify-between border-b border-slate-200 pb-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-slate-50 border border-slate-200 flex items-center justify-center text-slate-700">
              <Settings className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-900">Settings</h2>
              
            </div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-900 p-1 rounded-md hover:bg-slate-100 cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-2 my-5 text-xs">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-slate-700">Connections</span>
            <button onClick={onRefreshHealth} className="flex items-center gap-1 px-2.5 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs cursor-pointer">
              <RefreshCw className="w-3 h-3" /> Re-check
            </button>
          </div>
          {!health ? (
            <div className="p-3 rounded bg-amber-50 border border-amber-200 text-amber-800">Server not reachable.</div>
          ) : (
            <>
              <Row
                ok={health.ai.configured}
                icon={<Cpu className="w-4 h-4 text-amber-600" />}
                title="AI"
                detail={health.ai.configured ? `Using: ${health.ai.providers.join(' → ')} (automatic fallback)` : 'No AI key yet'}
                hint={health.ai.configured ? undefined : 'Add GEMINI_API_KEY (free at aistudio.google.com/apikey).'}
              />
              <Row
                ok={health.search.providers.some(p => p !== 'duckduckgo')}
                icon={<Search className="w-4 h-4 text-cyan-600" />}
                title="Search"
                detail={`Using: ${health.search.providers.join(' → ') || 'none'}`}
                hint={
                  health.search.providers.some(p => p !== 'duckduckgo')
                    ? undefined
                    : 'For more reliable results, add a free SERPER_API_KEY (serper.dev).'
                }
              />
              <Row
                ok={health.email.configured}
                icon={<Mail className="w-4 h-4 text-purple-600" />}
                title="Email sending"
                detail={
                  health.email.provider === 'gmail'
                    ? 'Gmail helper connected — emails go from your own Gmail'
                    : health.email.configured
                    ? `Sending via ${health.email.provider}`
                    : 'Not set up — you send from your own Gmail by hand.'
                }
                hint={health.email.provider === 'gmail' ? undefined : 'For automatic emails, set up the free Gmail helper script (see README).'}
              />
              {health.email.provider === 'gmail' && (
                <div className="-mt-1 flex flex-wrap items-center gap-2 text-xs px-3">
                  <button
                    type="button"
                    onClick={async () => {
                      setTest({ busy: true });
                      try {
                        const r = await api.gmailTest();
                        setTest({ ok: r.ok, message: r.message });
                      } catch (e: any) {
                        setTest({ ok: false, message: e?.message || 'Test failed' });
                      }
                    }}
                    disabled={test.busy}
                    className="px-2.5 py-1 rounded border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 font-medium cursor-pointer disabled:opacity-60"
                  >
                    {test.busy ? 'Testing…' : 'Test Gmail helper connection'}
                  </button>
                  {test.message && <span className={test.ok ? 'text-emerald-700' : 'text-red-700'}>{test.ok ? '✓ ' : '✗ '}{test.message}</span>}
                </div>
              )}
              <Row
                ok={health.storage.persistent}
                icon={<Database className="w-4 h-4 text-emerald-600" />}
                title="CRM storage"
                detail={health.storage.path}
                hint={
                  health.storage.persistent
                    ? undefined
                    : 'On Railway, add a Volume at /data so your list survives updates.'
                }
              />
              {!health.passwordRequired && (
                <div className="p-2.5 rounded bg-amber-50 border border-amber-200 text-amber-800 text-xs">
                  Tip: set APP_PASSWORD so only you can use the app.
                </div>
              )}
            </>
          )}
        </div>

        <form
          onSubmit={e => {
            e.preventDefault();
            onSaveSettings(form);
            onClose();
          }}
          className="space-y-4 text-xs"
        >
          <div className="font-semibold text-slate-700">Preferences</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-500 mb-1">People to find per run</label>
              <input
                type="number"
                min={10}
                max={300}
                className={field}
                value={form.leadsPerRun}
                onChange={e => setForm({ ...form, leadsPerRun: Math.max(10, Math.min(300, Number(e.target.value) || 10)) })}
              />
            </div>
            <div>
              <label className="block text-slate-500 mb-1">Skip anyone scoring below</label>
              <input
                type="number"
                min={0}
                max={100}
                className={field}
                value={form.minFitScoreToKeep}
                onChange={e => setForm({ ...form, minFitScoreToKeep: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-slate-500 mb-1">Geography focus</label>
              <input className={field} value={form.geographyFocus} onChange={e => setForm({ ...form, geographyFocus: e.target.value })} />
            </div>
            <div>
              <label className="block text-slate-500 mb-1">Sign emails as</label>
              <input className={field} value={form.senderName} placeholder="Your name" onChange={e => setForm({ ...form, senderName: e.target.value })} />
            </div>
            <div>
              <label className="block text-slate-500 mb-1">Reply-to email</label>
              <input className={field} value={form.senderEmail} placeholder="you@safecartkids.com" onChange={e => setForm({ ...form, senderEmail: e.target.value })} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-slate-700 cursor-pointer">
            <input type="checkbox" checked={form.lookupLinkedInProfiles} onChange={e => setForm({ ...form, lookupLinkedInProfiles: e.target.checked })} />
            Find each investor's LinkedIn profile
          </label>
          <label className="flex items-center gap-2 text-slate-700 cursor-pointer">
            <input type="checkbox" checked={form.includeLocalAngelGroups} onChange={e => setForm({ ...form, includeLocalAngelGroups: e.target.checked })} />
            Include local angel groups
          </label>

          <div className="font-semibold text-slate-700 pt-2">Deep research</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-500 mb-1">Deep-research anyone scoring at least</label>
              <input
                type="number"
                min={0}
                max={100}
                className={field}
                value={form.deepResearchMinScore}
                onChange={e => setForm({ ...form, deepResearchMinScore: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
              />
            </div>
            <div>
              <label className="block text-slate-500 mb-1">Max deep-researched per run</label>
              <input
                type="number"
                min={1}
                max={300}
                className={field}
                value={form.deepResearchPerRun}
                onChange={e => setForm({ ...form, deepResearchPerRun: Math.max(1, Math.min(300, Number(e.target.value) || 1)) })}
              />
            </div>
          </div>

          <div className="font-semibold text-slate-700 pt-2">Automatic email</div>
          <label className="flex items-center gap-2 text-slate-700 cursor-pointer">
            <input type="checkbox" checked={form.autoEmailEnabled} onChange={e => setForm({ ...form, autoEmailEnabled: e.target.checked })} />
            Automatically email investors (and send follow-ups)
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-500 mb-1">Only people scoring at least</label>
              <input
                type="number"
                min={0}
                max={100}
                className={field}
                value={form.autoEmailMinScore}
                onChange={e => setForm({ ...form, autoEmailMinScore: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
              />
            </div>
            <div>
              <label className="block text-slate-500 mb-1">Max emails per day</label>
              <input
                type="number"
                min={1}
                max={500}
                className={field}
                value={form.dailyEmailLimit}
                onChange={e => setForm({ ...form, dailyEmailLimit: Math.max(1, Math.min(500, Number(e.target.value) || 1)) })}
              />
            </div>
            <div>
              <label className="block text-slate-500 mb-1">Wait before first email (minutes, time to cancel)</label>
              <input
                type="number"
                min={0}
                max={10080}
                className={field}
                value={form.emailHoldMinutes}
                onChange={e => setForm({ ...form, emailHoldMinutes: Math.max(0, Math.min(10080, Number(e.target.value) || 0)) })}
              />
            </div>
            <div>
              <label className="block text-slate-500 mb-1">LinkedIn requests per day (reminder list)</label>
              <input
                type="number"
                min={1}
                max={100}
                className={field}
                value={form.linkedinDailyLimit}
                onChange={e => setForm({ ...form, linkedinDailyLimit: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })}
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-slate-500 mb-1">Company postal address (required by US anti-spam law in cold emails)</label>
              <input
                className={field}
                value={form.companyAddress}
                placeholder="SafeCart Kids, street, Chandler, AZ 85286, USA"
                onChange={e => setForm({ ...form, companyAddress: e.target.value })}
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-slate-500 mb-1">Calendar booking link (Google Calendar booking page of safecartkidsai@gmail.com — goes in investor emails)</label>
              <input
                className={field}
                value={form.bookingLink || ''}
                placeholder="https://calendar.app.google/…"
                onChange={e => setForm({ ...form, bookingLink: e.target.value.trim() })}
              />
              {form.bookingLink && !/^https?:\/\/\S+$/.test(form.bookingLink) && (
                <div className="text-xs text-red-700 mt-1">This doesn't look like a link — it must start with https://</div>
              )}
              {form.bookingLink && /calendar\.google\.com\/calendar\/u\/\d\/r/.test(form.bookingLink) && (
                <div className="text-xs text-red-700 mt-1">That's your own calendar page — investors can't book with it. Use the booking page link (see README → "Calendar booking page").</div>
              )}
              {!form.bookingLink && <div className="text-xs text-slate-500 mt-1">Empty = emails say "just reply to this email with a time that works best for you".</div>}
            </div>
          </div>
          {form.autoEmailEnabled && health?.email.provider !== 'gmail' && (
            <div className="p-2.5 rounded bg-amber-50 border border-amber-200 text-amber-800 text-xs">
              Automatic emails need the free Gmail helper script (see README → "Automatic email"). Until it's connected, nothing is sent.
            </div>
          )}
          {form.autoEmailEnabled && !form.companyAddress && (
            <div className="p-2.5 rounded bg-amber-50 border border-amber-200 text-amber-800 text-xs">Add your company postal address before sending cold emails to US investors.</div>
          )}

          <div className="pt-3 border-t border-slate-200 flex items-center justify-between">
            <button
              type="button"
              onClick={() => {
                onClearCrm();
                onClose();
              }}
              className="px-3 py-1.5 rounded border border-red-200 text-red-600 hover:bg-red-100 cursor-pointer"
            >
              Clear all investors
            </button>
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className="px-3 py-1.5 text-slate-500 hover:text-slate-900 rounded hover:bg-slate-100 cursor-pointer">
                Cancel
              </button>
              <button type="submit" className="flex items-center gap-1 px-4 py-1.5 font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded cursor-pointer">
                <Check className="w-3.5 h-3.5" /> Save
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
