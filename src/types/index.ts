// Shared types — used by both the React frontend (src/) and the Node backend (server/).

export type OutreachStatus =
  | 'discovered'
  | 'researched'
  | 'hot'
  | 'warm'
  | 'contacted'
  | 'replied'
  | 'meeting'
  | 'diligence'
  | 'passed';

export type InvestmentStage = 'Pre-seed' | 'Seed' | 'Series A' | 'Growth' | 'All Stages' | 'Unknown';

export type InvestorType =
  | 'Angel'
  | 'VC Fund'
  | 'Micro-VC'
  | 'Family Office'
  | 'Angel Group'
  | 'Accelerator'
  | 'Corporate VC'
  | 'Other'
  // fundraising experts (the "Fundraising experts" list)
  | 'Fundraising Consultant'
  | 'Fundraising Advisor'
  | 'Pitch Deck Consultant'
  | 'Fractional CFO'
  | 'Startup Lawyer'
  | 'Investment Banker'
  | 'Startup Advisor';

/** Which list a contact belongs to (dropdown at the top of the app). Missing = 'investors'. */
export type Audience = 'investors' | 'experts';

export interface EmailSequenceStep {
  stepNumber: number;
  dayDelay: number;
  stepName: string;
  subject: string;
  body: string;
  rationale: string;
  sentAt?: string;
}

export interface InvestorFitScore {
  total: number; // 0 - 100
  thesisMatch: number;
  stageMatch: number;
  sectorMatch: number;
  checkSizeMatch: number;
  synergyMatch: number;
  status: 'hot' | 'warm' | 'cold';
  verdict: string;
  whyInvest: string[];
  hesitations: string[];
  keyTalkingPoint: string;
}

export interface ExtractedCrawlData {
  rawUrl: string;
  crawledAt: string;
  pageTitle: string;
  metaDescription: string;
  extractedTextExcerpt: string;
  keyQuotes: string[];
  portfolioFound: string[];
  detectedCheckSize: string;
  detectedContactEmail: string;
}

export interface Investor {
  id: string;
  name: string;
  title: string;
  firm: string;
  investorType?: InvestorType;
  website: string;
  email: string;
  /** Public phone number found on their own website (US format), if any. */
  phone?: string;
  linkedin: string;
  twitter?: string;
  location: string;
  /** Country they are based in, as found by the research (we target the USA). */
  country?: string;
  /** Do they ask founders for money BEFORE anything happens (retainer, application / pitch / membership fee)? */
  upfrontFee?: 'yes' | 'no' | 'unknown';
  /** How they get paid, in one line (e.g. "success fee only", "$5k/month retainer", "$250 pitch fee"). */
  feeModel?: string;
  stage: InvestmentStage;
  checkSizeFormatted: string;
  checkSizeMin: number;
  checkSizeMax: number;
  industries: string[];
  portfolio: string[];
  recentInvestments: { name: string; year: string; sector: string; note: string }[];
  thesis: string;
  antiPortfolio?: string[];
  contactRoute: string;
  activePartner: string;
  fitScore: InvestorFitScore;
  researchNotes: string;
  extractedData: ExtractedCrawlData;
  /** Public pages the agent used as evidence for this investor. */
  sourceUrls?: string[];
  /** Short LinkedIn connection-request note (<= 300 chars). */
  linkedinNote?: string;
  /** Longer LinkedIn DM to send after they accept. */
  linkedinMessage?: string;
  /** 'quick' = scored from search results only; 'deep' = website researched + outreach written. */
  researchDepth?: 'quick' | 'deep';
  /** 'investors' (default) or 'experts' — which list this contact belongs to */
  audience?: Audience;
  /** version of the email finder that last looked for this investor's email */
  emailSearchV?: number;
  /** Search-snippet score from the quick scan (0-100). */
  quickScore?: number;
  /** Campaign run that found this investor. */
  campaignId?: string;
  outreach: {
    status: OutreachStatus;
    sequenceGenerated: boolean;
    sequences: EmailSequenceStep[];
    lastContactedDate?: string;
    nextFollowUpDate?: string;
    responseNotes?: string;
    replyDate?: string;
    sentStepsCount: number;
    /** version of the email template used to write the sequence (older ones are rewritten before auto-sending) */
    templateV?: number;
    linkedinRequestSentAt?: string;
    linkedinAcceptedAt?: string;
    linkedinMessagedAt?: string;
    /** Stop automatic emails for this investor only. */
    autoPaused?: boolean;
    /** Why the last automatic email failed (if it did). */
    autoError?: string;
  };
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface StartupProfile {
  name: string;
  website?: string;
  oneLiner: string;
  category: string;
  stage: InvestmentStage;
  targetRaise: string;
  checkSizeMin: string;
  checkSizeMax: string;
  location: string;
  tractionHighlights: string[];
  problem: string;
  secretSauce: string;
  idealInvestorTraits: string;
  keyFeatures?: string[];
  founderName?: string;
  founderEmail?: string;
  /** Anything else the founder wants the agent to know (pasted text, notes, app-store copy...). */
  extraContext?: string;

  // ---- Phase 1: AI-generated product intelligence ----
  productDescription?: string;
  targetCustomers?: string[];
  endUsers?: string[];
  businessModel?: string;
  marketDescription?: string;
  competitors?: string[];
  differentiation?: string[];
  fundingUse?: string[];
  investorKeywords?: string[];
  investorTypesToTarget?: string[];
  linkedinSearchQueries?: string[];
  webSearchQueries?: string[];
  risksInvestorsWillAsk?: string[];
  aiConfidence?: number;
  aiGeneratedAt?: string;
}

export interface PipelineExecutionLog {
  id: string;
  timestamp: string;
  phase: 'product' | 'search' | 'extract' | 'research' | 'score' | 'outreach' | 'crm' | 'system';
  message: string;
  level: 'info' | 'success' | 'warn' | 'error';
  investorName?: string;
}

export interface AppSettings {
  leadsPerRun: number;
  minFitScoreToKeep: number;
  geographyFocus: string;
  lookupLinkedInProfiles: boolean;
  includeLocalAngelGroups: boolean;
  senderName: string;
  senderEmail: string;

  // ---- big runs ----
  /** Deep-research (read website + write outreach) only investors whose quick score is at least this. */
  deepResearchMinScore: number;
  /** Max investors to deep-research per run (the rest stay as quick-scanned). */
  deepResearchPerRun: number;

  // ---- automatic email (needs the Gmail script) ----
  autoEmailEnabled: boolean;
  autoEmailMinScore: number;
  dailyEmailLimit: number;
  /** Minutes to wait after an investor is added before the first automatic email (time to cancel). */
  emailHoldMinutes: number;
  /** Company postal address — US anti-spam law (CAN-SPAM) requires it in cold emails. */
  companyAddress: string;

  // ---- LinkedIn ----
  linkedinDailyLimit: number;

  /** Google Calendar booking page link put in investor emails ("schedule a time that works best for you here"). */
  bookingLink?: string;

  /** What the app is looking for right now (dropdown at the top). Missing = 'investors'. */
  audience?: Audience;
}

export interface CampaignCandidate extends DiscoveryCandidate {
  stage: 'found' | 'quick' | 'researched' | 'skipped' | 'failed';
  quickScore?: number;
  quickReason?: string;
  investorId?: string;
  attempts?: number;
  /** re-research even if already deep-researched (email re-check) */
  force?: boolean;
  hasEmail?: boolean;
}

export interface Campaign {
  id: string;
  status: 'running' | 'paused' | 'done' | 'error';
  target: number;
  mode: 'quick' | 'deep' | 'upgrade';
  /** who this run looks for */
  audience?: Audience;
  startedAt: string;
  finishedAt?: string;
  phase: 'queries' | 'search' | 'extract' | 'quick' | 'deep' | 'done';
  queries: string[];
  queryCursor: number;
  candidates: CampaignCandidate[];
  logs: PipelineExecutionLog[];
  error?: string;
  counts?: { found: number; quick: number; researched: number; skipped: number; failed: number; withEmail?: number };
  /** people found but not needed yet — the next run starts with them */
  spare?: CampaignCandidate[];
}

export interface AutomationStatus {
  emailProvider: string;
  autoEmailEnabled: boolean;
  sentToday: number;
  dailyLimit: number;
  gmailRemaining?: number;
  queued: number;
  lastRunAt?: string;
  lastCheckAt?: string;
  lastError?: string;
  recent: { at: string; message: string; level: 'info' | 'success' | 'warn' | 'error' }[];
}

/** A raw "possible investor" found by search, before deep research. */
export interface DiscoveryCandidate {
  id: string;
  name: string;
  firm: string;
  title: string;
  investorType: InvestorType;
  linkedinUrl: string;
  websiteUrl: string;
  sourceUrl: string;
  sourceTitle: string;
  snippet: string;
  whyRelevant: string;
  location: string;
  alreadyInCrm?: boolean;
  /** which list it was found for */
  audience?: Audience;
}

export interface AgentJob {
  id: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  progress: number;
  logs: PipelineExecutionLog[];
  investors: Investor[];
  startupUpdate?: Partial<StartupProfile>;
  error?: string;
}

export interface HealthInfo {
  ok: boolean;
  ai: { configured: boolean; providers: string[] };
  search: { providers: string[] };
  email: { configured: boolean; provider: string };
  storage: { persistent: boolean; path: string };
  passwordRequired: boolean;
}
