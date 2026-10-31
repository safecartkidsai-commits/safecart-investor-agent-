/**
 * The emails the agent sends — word for word from the founder's own text.
 * Only three things change per person:
 *   1. the greeting ("Hi Lars,")
 *   2. ONE short sentence about that person, written by the AI from their research (it is left out if the
 *      research found nothing specific — it is never invented)
 *   3. the booking link (Settings → "Calendar booking link")
 * To change the wording, edit the text below. Keep the {placeholders}.
 */

/** Bump when the templates change: unsent emails written with an older version are rebuilt before auto-sending. */
export const TEMPLATE_V = 3;

export const FOUNDER_NAME = 'Mohammad Hanafi';
export const COMPANY_NAME = 'SafeCartKids';

export const EXPERT_TERMS = {
  successFee: '5%',
  equity: 'Up to 0.5%'
};

// ------------------------------------------------------------------ investors
export const INVESTOR_SUBJECT = 'SafeCartKids — building the next Amazon for families';

export const INVESTOR_EMAIL = `{greeting}
Would you like to be part of what could become the next $10 billion family-focused e-commerce company (the next Amazon)?
What if the next major breakthrough in e-commerce was a platform that empowers children to shop safely while protecting them and their families through a trusted, AI-powered online experience?
I'm the founder of SafeCartKids, an AI-powered e-commerce platform built specifically for children and families.
Today, parents face a growing challenge: children are increasingly exposed to inappropriate products, content, and online experiences through traditional shopping platforms. SafeCartKids addresses this problem by combining AI-powered content filtering, parental controls, and educational engagement into a single child-safe ecosystem.
Our vision is to become the trusted digital commerce ecosystem for families worldwide, creating both meaningful social impact and significant commercial opportunity.
{personal}I'm currently speaking with a select group of investors and strategic partners who are interested in backing technologies that solve real-world problems while addressing large, underserved markets.
Would you be open to a brief 15-minute conversation to explore whether SafeCartKids aligns with your investment interests?
{booking}
Best regards,
Mohammad Hanafi
Founder, SafeCartKids`;

const INVESTOR_FOLLOW_UPS = [
  {
    day: 4,
    subject: 'Re: SafeCartKids — building the next Amazon for families',
    body: `{greeting}
I wanted to follow up on my note about SafeCartKids, the AI-powered, child-safe e-commerce platform for families.
We're speaking with a small group of pre-seed investors, and I'd value your perspective.
Would you be open to a brief 15-minute conversation?
{booking}
Best regards,
Mohammad Hanafi
Founder, SafeCartKids`
  },
  {
    day: 10,
    subject: 'Re: SafeCartKids — building the next Amazon for families',
    body: `{greeting}
One more thought on SafeCartKids: parents want control over what their children see and buy online, and today's platforms weren't built for that. We're building the trusted commerce ecosystem for families.
If it fits your investment interests, I'd be glad to share more in a quick 15-minute call.
{booking}
Best regards,
Mohammad Hanafi
Founder, SafeCartKids`
  },
  {
    day: 21,
    subject: 'Re: SafeCartKids — building the next Amazon for families',
    body: `{greeting}
I don't want to fill your inbox, so this will be my last note for now.
If SafeCartKids could align with your investment interests in the future, I'd be happy to reconnect at any time.
Thank you for your time and consideration.
Best regards,
Mohammad Hanafi
Founder, SafeCartKids`
  }
];

// ------------------------------------------------------------------ fundraising experts
export const EXPERT_SUBJECT = 'Fundraising Partnership Opportunity — SafeCartKids';

export const EXPERT_EMAIL = `{greeting}
I'm Mohammad Hanafi, founder of SafeCartKids, an AI-powered e-commerce platform designed to make online shopping safer for children while giving parents control over purchasing decisions.
{personal}We are seeking an experienced fundraising professional to help us secure pre-seed investment and build relationships with qualified angel investors, venture capital firms, and strategic partners.
We offer a performance-based compensation structure:
{successFee} success fee on qualifying investment funds successfully secured and received by the company through your efforts.
No upfront fees, retainers, or advance payments.
{equity} equity as an additional incentive, subject to agreed fundraising milestones, continued contribution, and formal documentation.
We are looking for someone with a verifiable track record in early-stage startup fundraising, strong investor relationships, and a long-term interest in helping build a potentially significant family-focused technology company.
If you have relevant experience and are interested in a results-based partnership, please share your fundraising track record, examples of successful raises, and proposed approach.
Let's explore whether we can build a successful partnership.
Mohammad Hanafi
Founder, SafeCartKids`;

const EXPERT_FOLLOW_UPS = [
  {
    day: 4,
    subject: 'Re: Fundraising Partnership Opportunity — SafeCartKids',
    body: `{greeting}
I wanted to follow up on my note about a results-based fundraising partnership with SafeCartKids: a {successFee} success fee on funds secured and received, with no upfront fees, retainers, or advance payments.
If this interests you, please share your fundraising track record and proposed approach.
Mohammad Hanafi
Founder, SafeCartKids`
  },
  {
    day: 10,
    subject: 'Re: Fundraising Partnership Opportunity — SafeCartKids',
    body: `{greeting}
We're preparing our pre-seed round and want to work with someone who has strong relationships with angel investors and venture capital firms.
If you'd like to explore a performance-based partnership, I'd be glad to share more about SafeCartKids.
Mohammad Hanafi
Founder, SafeCartKids`
  },
  {
    day: 21,
    subject: 'Re: Fundraising Partnership Opportunity — SafeCartKids',
    body: `{greeting}
This will be my last note for now. If a results-based fundraising partnership with SafeCartKids interests you in the future, I'd be happy to reconnect.
Let's explore whether we can build a successful partnership.
Mohammad Hanafi
Founder, SafeCartKids`
  }
];

// ------------------------------------------------------------------ building the emails
const NOT_A_PERSON = /\b(capital|ventures?|partners|fund|group|angels?|llc|inc|advisors?|consulting|network|club|firm|team|associates|attorneys?|law)\b/i;

/** "Hi Lars," — or "Hello," when we only know a company name. */
export function greetingFor(name: string, firm?: string): string {
  // "Dr. John Smith, CFA" → John
  const n = (name || '')
    .replace(/[,|(–—-].*$/, '')
    .replace(/^(dr|mr|mrs|ms|miss|prof|professor|sir)\.?\s+/i, '')
    .trim();
  const parts = n.split(/\s+/).filter(Boolean);
  const looksLikePerson = parts.length >= 2 && parts.length <= 4 && !NOT_A_PERSON.test(n) && n.toLowerCase() !== (firm || '').trim().toLowerCase();
  if (!looksLikePerson) return 'Hello,';
  const first = parts[0].replace(/[^A-Za-zÀ-ÿ'-]/g, '');
  return first.length >= 2 ? `Hi ${first},` : 'Hello,';
}

/** Clean the AI's one personal sentence; empty if it looks wrong. */
export function cleanPersonalLine(line?: string): string {
  let t = (line || '').replace(/\s+/g, ' ').trim().replace(/^["'“]+|["'”]+$/g, '');
  if (!t || t.length < 15) return '';
  if (/[\[\]{}<>]|lorem|placeholder|\bN\/A\b|unknown/i.test(t)) return '';
  if (t.length > 260) t = t.slice(0, 260).replace(/\s+\S*$/, '') + '…';
  if (!/[.!?…]$/.test(t)) t += '.';
  return t;
}

export function bookingLine(link?: string): string {
  const l = (link || '').trim();
  return /^https?:\/\/\S+$/i.test(l)
    ? `If so, you can schedule a time that works best for you here:\n${l}`
    : 'If so, just reply to this email with a time that works best for you.';
}

function fill(text: string, v: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (_m, k) => (k in v ? v[k] : `{${k}}`));
}

export interface BuiltStep {
  stepNumber: number;
  dayDelay: number;
  stepName: string;
  subject: string;
  body: string;
  rationale: string;
}

/** The 4 emails for one person, from the templates above. */
export function buildEmails(
  audience: 'investors' | 'experts',
  person: { name: string; firm?: string },
  personalLine: string,
  bookingLink?: string
): BuiltStep[] {
  const personal = cleanPersonalLine(personalLine);
  const v = {
    greeting: greetingFor(person.name, person.firm),
    personal: personal ? `${personal}\n` : '',
    booking: bookingLine(bookingLink),
    successFee: EXPERT_TERMS.successFee,
    equity: EXPERT_TERMS.equity
  };
  const exp = audience === 'experts';
  const first: BuiltStep = {
    stepNumber: 1,
    dayDelay: 0,
    stepName: 'Intro',
    subject: exp ? EXPERT_SUBJECT : INVESTOR_SUBJECT,
    body: fill(exp ? EXPERT_EMAIL : INVESTOR_EMAIL, v),
    rationale: personal ? `Personal line: ${personal}` : 'No specific detail found — sent without a personal line.'
  };
  const follow: BuiltStep[] = (exp ? EXPERT_FOLLOW_UPS : INVESTOR_FOLLOW_UPS).map((f, k) => ({
    stepNumber: k + 2,
    dayDelay: f.day,
    stepName: ['Follow-up', 'Value add', 'Close the loop'][k],
    subject: f.subject,
    body: fill(f.body, v),
    rationale: 'Template follow-up'
  }));
  return [first, ...follow];
}

/** LinkedIn texts (connection note max 280 characters). */
export function buildLinkedIn(audience: 'investors' | 'experts', person: { name: string; firm?: string }, bookingLink?: string) {
  const g = greetingFor(person.name, person.firm).replace(/,$/, '');
  if (audience === 'experts') {
    return {
      note: `${g} — I'm Mohammad Hanafi, founder of SafeCartKids (AI-powered, child-safe e-commerce). We're looking for a fundraising partner on a performance basis: ${EXPERT_TERMS.successFee} success fee, no upfront fees. Would love to connect.`.slice(0, 280),
      message: `${g}, thanks for connecting! We're seeking an experienced fundraising professional to help SafeCartKids secure pre-seed investment. We offer a ${EXPERT_TERMS.successFee} success fee on funds secured and received, no upfront fees or retainers, and ${EXPERT_TERMS.equity.toLowerCase()} equity subject to milestones. If you're interested, could you share your fundraising track record and proposed approach?`
    };
  }
  const book = bookingLine(bookingLink).replace(/^If so, /, '');
  return {
    note: `${g} — I'm Mohammad Hanafi, founder of SafeCartKids, an AI-powered e-commerce platform built for children and families (the next Amazon for families). I'd love to connect.`.slice(0, 280),
    message: `${g}, thanks for connecting! SafeCartKids is an AI-powered, child-safe e-commerce platform for families. I'm speaking with a select group of investors — would you be open to a brief 15-minute conversation? ${book.charAt(0).toUpperCase()}${book.slice(1)}`
  };
}
