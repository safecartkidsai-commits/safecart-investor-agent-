import { Investor, StartupProfile, AppSettings } from '../types';
import { DEFAULT_STARTUP, DEFAULT_SETTINGS } from '../data/defaultStartup';

// Browser cache of the CRM. The server copy (/api/state) is the source of truth;
// this cache makes the app load instantly and survive a server restart.
const STORAGE_KEY_INVESTORS = 'safecart_agent_investors_v2';
const STORAGE_KEY_STARTUP = 'safecart_agent_startup_v2';
const STORAGE_KEY_SETTINGS = 'safecart_agent_settings_v2';

export { DEFAULT_SETTINGS };

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked — server copy still exists */
  }
}

export const loadStoredInvestors = (): Investor[] => {
  const v = read<Investor[]>(STORAGE_KEY_INVESTORS);
  return Array.isArray(v) ? v : [];
};
export const saveStoredInvestors = (investors: Investor[]) => write(STORAGE_KEY_INVESTORS, investors);

export const loadStoredStartup = (): StartupProfile => ({ ...DEFAULT_STARTUP, ...(read<StartupProfile>(STORAGE_KEY_STARTUP) || {}) });
export const saveStoredStartup = (startup: StartupProfile) => write(STORAGE_KEY_STARTUP, startup);

export const loadStoredSettings = (): AppSettings => ({ ...DEFAULT_SETTINGS, ...(read<AppSettings>(STORAGE_KEY_SETTINGS) || {}) });
export const saveStoredSettings = (settings: AppSettings) => write(STORAGE_KEY_SETTINGS, settings);

export const exportInvestorsToCsv = (investors: Investor[]): string => {
  const headers = [
    'Name',
    'Firm',
    'Title',
    'Website',
    'Email',
    'LinkedIn',
    'Location',
    'Investment Stage',
    'Investment Size',
    'Fit Score',
    'Fit Verdict',
    'Industries',
    'Portfolio',
    'Outreach Status',
    'Next Follow-up',
    'Research Notes',
    'Investor Type',
    'LinkedIn Note',
    'Sources'
  ];

  const escapeCsv = (str: string | undefined | null) => {
    if (!str) return '""';
    const escaped = String(str).replace(/"/g, '""');
    return `"${escaped}"`;
  };

  const rows = investors.map(inv => [
    escapeCsv(inv.name),
    escapeCsv(inv.firm),
    escapeCsv(inv.title),
    escapeCsv(inv.website),
    escapeCsv(inv.email),
    escapeCsv(inv.linkedin),
    escapeCsv(inv.location),
    escapeCsv(inv.stage),
    escapeCsv(inv.checkSizeFormatted),
    escapeCsv(inv.fitScore?.total ? `${inv.fitScore.total}%` : 'N/A'),
    escapeCsv(inv.fitScore?.verdict || ''),
    escapeCsv(inv.industries.join(', ')),
    escapeCsv(inv.portfolio.join(', ')),
    escapeCsv(inv.outreach.status),
    escapeCsv(inv.outreach.nextFollowUpDate || ''),
    escapeCsv(inv.researchNotes),
    escapeCsv(inv.investorType || ''),
    escapeCsv(inv.linkedinNote || ''),
    escapeCsv((inv.sourceUrls || []).join(' '))
  ]);

  return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
};

export const exportToMauticCsv = (investors: Investor[]): string => {
  const headers = [
    'firstname',
    'lastname',
    'company',
    'title',
    'email',
    'website',
    'city',
    'tags',
    'points',
    'custom_check_size',
    'custom_thesis_notes',
    'custom_step1_subject',
    'custom_step1_body'
  ];

  const escapeCsv = (str: string | undefined | null) => {
    if (!str) return '""';
    const escaped = String(str).replace(/"/g, '""');
    return `"${escaped}"`;
  };

  const rows = investors.map(inv => {
    const names = inv.name.split(' ');
    const firstname = names[0] || '';
    const lastname = names.slice(1).join(' ') || '';
    const step1 = inv.outreach.sequences?.[0];

    return [
      escapeCsv(firstname),
      escapeCsv(lastname),
      escapeCsv(inv.firm),
      escapeCsv(inv.title),
      escapeCsv(inv.email),
      escapeCsv(inv.website),
      escapeCsv(inv.location),
      escapeCsv(inv.tags.join(';')),
      escapeCsv(inv.fitScore?.total?.toString() || '0'),
      escapeCsv(inv.checkSizeFormatted),
      escapeCsv(inv.thesis),
      escapeCsv(step1?.subject || ''),
      escapeCsv(step1?.body || '')
    ].join(',');
  });

  return [headers.join(','), ...rows].join('\n');
};

export const exportToTwentyCrmJson = (investors: Investor[]): string => {
  const twentyRecords = investors.map(inv => ({
    name: {
      firstName: inv.name.split(' ')[0] || '',
      lastName: inv.name.split(' ').slice(1).join(' ') || ''
    },
    company: inv.firm,
    jobTitle: inv.title,
    emails: { primaryEmail: inv.email },
    links: {
      primaryLinkUrl: inv.website,
      secondaryLinkUrl: inv.linkedin
    },
    city: inv.location,
    customFields: {
      stage: inv.stage,
      checkSize: inv.checkSizeFormatted,
      fitScore: inv.fitScore.total,
      outreachStatus: inv.outreach.status,
      nextFollowUp: inv.outreach.nextFollowUpDate,
      portfolioMatches: inv.portfolio,
      researchNotes: inv.researchNotes
    }
  }));

  return JSON.stringify(twentyRecords, null, 2);
};
