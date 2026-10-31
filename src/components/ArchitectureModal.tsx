import React from 'react';
import { X, ArrowDown, ShieldCheck } from 'lucide-react';

interface ArchitectureModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const STEPS = [
  ['1 · Your app', 'Reads your website and the details you entered.'],
  ['2 · Search', 'Looks for investors — or fundraising experts, if you pick that in the dropdown at the top — on LinkedIn and across the web.'],
  ['3 · Research', "Reads each person's website and finds their LinkedIn."],
  ['4 · Score', 'Gives each one a fit score from 0 to 100.'],
  ['5 · Write', 'Drafts a LinkedIn note and 4 follow-up emails.'],
  ['6 · Track', 'Reminds you when a follow-up is due.']
];


export const ArchitectureModal: React.FC<ArchitectureModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/30 backdrop-blur-sm overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-xl max-w-3xl w-full p-6 text-slate-800 shadow-2xl my-8">
        <div className="flex items-center justify-between border-b border-slate-200 pb-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">How the agent works</h2>
            <p className="text-xs text-slate-500">From your app to replies, in six steps. Works the same for investors and fundraising experts — each has its own list.</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-900 p-1 rounded-md hover:bg-slate-100 cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="my-5 space-y-1.5">
          {STEPS.map(([t, d], i) => (
            <React.Fragment key={t}>
              <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                <div className="text-xs font-semibold text-slate-900">{t}</div>
                <div className="text-xs text-slate-500 mt-0.5">{d}</div>
              </div>
              {i < STEPS.length - 1 && <ArrowDown className="w-3.5 h-3.5 mx-auto text-slate-400" />}
            </React.Fragment>
          ))}
        </div>

        <div className="mt-4 p-3 rounded-lg bg-sky-50 border border-sky-200 text-xs text-sky-900 flex gap-2">
          <ShieldCheck className="w-4 h-4 shrink-0 text-sky-600" />
          <span>
            The agent never logs in to your LinkedIn. It writes the note, and you send it yourself.
          </span>
        </div>
      </div>
    </div>
  );
};
