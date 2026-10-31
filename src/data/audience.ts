/**
 * Who the agent is looking for. Picked from the dropdown at the top of the app.
 *   investors → people and funds who could invest in the company
 *   experts   → fundraising experts who could HELP the company raise (consultants, advisors,
 *               pitch-deck / financial-model specialists, fractional CFOs, startup lawyers, boutique bankers)
 * Every saved contact remembers which list it belongs to (Investor.audience), so the two lists never mix.
 * Shared by the server (searches, scoring, emails) and the app (labels).
 */
import type { Audience } from '../types';
export type { Audience };

export const audienceOf = (x?: { audience?: string } | null): Audience => (x?.audience === 'experts' ? 'experts' : 'investors');

export const AUDIENCE_TEXT = {
  investors: {
    menu: 'Investors',
    /** Gmail label put on the email thread (sent + replies) */
    label: 'Investor',
    one: 'investor',
    many: 'investors',
    One: 'Investor',
    Many: 'Investors',
    find: 'Find investors',
    // fit-score bars
    fit: { thesis: 'Thesis', stage: 'Stage', sector: 'Sector', check: 'Check size', synergy: 'Synergy' },
    // profile fields
    field: { check: 'Check size', portfolio: 'Portfolio', thesis: 'Thesis', stage: 'Stage', why: 'Why they may invest' }
  },
  experts: {
    menu: 'Fundraising experts',
    label: 'Fundraising Expert',
    one: 'expert',
    many: 'experts',
    One: 'Expert',
    Many: 'Experts',
    find: 'Find experts',
    fit: { thesis: 'Specialty', stage: 'Stage fit', sector: 'Sector experience', check: 'Cost fit', synergy: 'Track record' },
    field: { check: 'Fees', portfolio: 'Past clients', thesis: 'Services', stage: 'Stages they help', why: 'Why they could help' }
  }
} as const;

export const textFor = (a: Audience) => AUDIENCE_TEXT[a];

/** Kinds of fundraising expert (stored in Investor.investorType for the experts list). */
export const EXPERT_TYPES = [
  'Fundraising Consultant',
  'Fundraising Advisor',
  'Pitch Deck Consultant',
  'Fractional CFO',
  'Startup Lawyer',
  'Investment Banker',
  'Startup Advisor'
] as const;

/** Fundraising experts = people whose job is RAISING MONEY for startups (not lawyers, designers, accountants, agencies). */
const EXPERT_ROLES = [
  'fundraising consultant',
  'fundraising advisor',
  'capital raising advisor',
  'startup fundraising consultant',
  'investor relations consultant',
  'capital raising consultant',
  'fundraising partner'
];

/** Lawyers / law firms: never fundraising experts here, whatever their title says. */
const LAWYER = /\b(attorneys?|lawyers?|law (firm|group|office|offices|partners)|llp|esq\.?|paralegal)\b/i;
/** Other vendors: excluded unless their title clearly says they raise money. */
export const NOT_FUNDRAISING_EXPERT =
  /\b(legal|counsel|cpa|accountants?|accounting|bookkeep\w*|tax (advisor|services)|marketing agency|digital agency|seo|web design|graphic design|pitch deck design\w*|deck designer|presentation design\w*|recruit\w*|staffing|insurance|realtor|mortgage)\b/i;
/** Words that show someone's job is raising money for startups. */
export const FUNDRAISING_WORDS = /\b(fundrais\w*|capital[- ]rais\w*|raise[sd]? capital|raising capital|investor relations|investor introductions?|angel investors?|venture capital|pre-seed|seed round|series a)\b/i;

export function isNotFundraisingExpert(x: { name?: string; firm?: string; title?: string; investorType?: string }): boolean {
  const text = `${x.title || ''} ${x.firm || ''} ${x.name || ''}`;
  if (x.investorType === 'Startup Lawyer' || LAWYER.test(text)) return true;
  return NOT_FUNDRAISING_EXPERT.test(text) && !FUNDRAISING_WORDS.test(`${x.title || ''} ${x.firm || ''}`);
}

/** Does what we know about them show they raise money for startups? (protects good experts from an over-strict AI "no") */
export function looksLikeFundraiser(x: { title?: string; firm?: string; thesis?: string; feeModel?: string; researchNotes?: string }): boolean {
  return FUNDRAISING_WORDS.test(`${x.title || ''} ${x.firm || ''} ${x.thesis || ''} ${x.feeModel || ''}`);
}

/** Search plan for fundraising experts. kw = themes from "Your App" (e.g. kids fintech), city = your city. */
export function expertQueries(kw: string[], city: string): { linkedin: string[]; web: string[] } {
  const k = kw.length ? kw : ['consumer apps', 'fintech', 'edtech'];
  const pick = (i: number) => k[i % k.length];
  // experts rarely write our themes (kids fintech…) on their profile — role + "startups" finds them
  const linkedin = EXPERT_ROLES.map((r, i) => `site:linkedin.com/in "${r}" ${i % 2 ? 'pre-seed' : 'startups'}`);
  const place = city || 'United States';
  const web = [
    'startup fundraising consultant pre-seed seed round',
    `fundraising consultant for startups ${pick(0)}`,
    'fundraising advisor helps startups raise seed round investor network',
    `capital raising advisor startups ${place}`,
    'fundraising consultant angel investor network startups',
    // experts who publish a way to email them (they sell a service, so many do)
    '"fundraising consultant" "contact" email startups',
    '"book a call" fundraising advisor startups',
    `fundraising advisor consumer apps ${pick(1)} startups`,
    'top fundraising consultants for startups',
    // paid from results, not upfront
    '"success fee" fundraising consultant startups',
    'commission based fundraising consultant pre-seed startups',
    '"no retainer" startup fundraising advisor',
    '"success-based" capital raising advisor seed round'
  ];
  return { linkedin, web };
}
