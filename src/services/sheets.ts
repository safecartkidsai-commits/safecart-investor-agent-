import { api } from './api';
import type { Audience } from '../types';

/**
 * "Open in Google Sheets": the server asks your Gmail helper script to create a Google Sheet in your Google Drive,
 * and the sheet opens in a new tab. No CSV / Excel file is ever downloaded.
 * If it can't be made, you get a message saying exactly what to fix.
 */
export async function openInGoogleSheets(audience: Audience, toast: (msg: string, error?: boolean) => void) {
  // open the tab right away (browsers block pop-ups opened after waiting)
  const tab = window.open('', '_blank');
  if (tab) tab.document.write('<p style="font-family:sans-serif;padding:24px">Creating your Google Sheet…</p>');
  try {
    const r = await api.sheet(audience);
    if (tab) tab.location.href = r.url;
    else window.open(r.url, '_blank');
    toast(
      (r.tabs || 1) > 1
        ? `Google Sheet created with 3 tabs — Investors, Fundraising Experts, and All together — with every detail. Also saved in your Google Drive.`
        : `Google Sheet created with ${r.rows} rows — update your Gmail helper script to get both tabs with every detail.`
    );
  } catch (e: any) {
    tab?.close();
    toast(`Couldn't create the Google Sheet: ${e?.message || 'unknown error'}`, true);
  }
}
