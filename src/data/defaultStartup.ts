import { StartupProfile, AppSettings } from '../types';

/**
 * SafeCart Kids — the real company profile the agent works for.
 * Only facts supplied by the founder are written here. Anything left blank
 * (raise amount, traction) is NOT invented by the AI; fill it in from the
 * "SafeCart Kids Brain" tab when you have it.
 */
export const DEFAULT_STARTUP: StartupProfile = {
  name: 'SafeCart Kids',
  website: 'https://www.safecartkids.com/',
  oneLiner:
    'The first safe shopping app designed for ages 6-14 — age-appropriate navigation, visual product discovery and educational spending prompts that teach financial literacy, overseen by parents.',
  category: 'Kids Commerce / Family Tech / Financial Literacy / AI-native Specialty eCommerce',
  stage: 'Pre-seed',
  targetRaise: '',
  checkSizeMin: '',
  checkSizeMax: '',
  location: 'Chandler, AZ, USA',
  tractionHighlights: [
    'Founded 2025, team of 2-10, headquartered in Chandler, Arizona',
    'Mobile app + web app'
  ],
  problem:
    'Kids aged 6-14 increasingly want to browse and buy online, but mainstream marketplaces expose them to adult content, predatory marketing and uncontrolled spending, and parents have no good way to let children shop and learn about money on their own safely.',
  secretSauce:
    'An AI-native, privacy-by-design shopping space built only for kids: parent-approved age-appropriate products, real-time spending controls and purchase approvals, category restrictions, educational spending prompts that teach financial literacy, exceeds COPPA 2.0 requirements with zero third-party data sharing.',
  idealInvestorTraits:
    'Pre-seed / seed angels and funds investing in family tech, kids & parenting, edtech, kids fintech / financial literacy, consumer commerce, child online safety & privacy, and AI-native consumer apps. Arizona / Southwest angels are a bonus.',
  keyFeatures: [
    'Parent-approved, age-appropriate products',
    'No adult content',
    'No predatory marketing',
    'Real-time spending controls & purchase approvals',
    'Category restrictions',
    'Exceeds COPPA 2.0 requirements',
    'Zero third-party data sharing',
    'Privacy by design',
    'AI-native'
  ],
  founderName: '',
  founderEmail: '',
  extraContext:
    'Mission: enabling children to explore, shop, and learn on their own within a secure, intelligent, and well-supervised digital space. Driven by AI and overseen by parents while fostering meaningful experiences of discovery, learning, and joy for the entire family. LinkedIn: SafeCartKids (Retail / Specialty eCommerce Retailer), ~15 associated members.'
};

export const DEFAULT_SETTINGS: AppSettings = {
  leadsPerRun: 100,
  minFitScoreToKeep: 40,
  geographyFocus: 'United States (bonus: Arizona / Southwest)',
  lookupLinkedInProfiles: true,
  includeLocalAngelGroups: true,
  senderName: '',
  senderEmail: '',
  deepResearchMinScore: 50,
  deepResearchPerRun: 40,
  autoEmailEnabled: false,
  autoEmailMinScore: 50,
  dailyEmailLimit: 25,
  emailHoldMinutes: 60,
  companyAddress: '',
  linkedinDailyLimit: 20,
  bookingLink: ''
};
