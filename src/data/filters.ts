/**
 * Who the agent keeps OUT of your lists and never emails:
 *   • people who ask for money upfront (retainers, application / pitch fees)
 *   • people outside your business's country (USA for Chandler, AZ)
 *   • in the experts list: anyone who is not really a fundraising expert (law firms, accountants, agencies…)
 * Used by the server (automatic emails) and by the app (hidden from the lists, with a "Show them" link).
 */
import type { Investor } from '../types';
import { audienceOf, isNotFundraisingExpert, looksLikeFundraiser } from './audience';
import { outsideTarget, TargetGeo, targetGeo } from './geo';

export function excludedReason(inv: Investor, geo: TargetGeo = targetGeo('')): string {
  if (inv.upfrontFee === 'yes') return 'asks for money upfront';
  if ((inv.tags || []).includes('Outside target country') || outsideTarget(`${inv.country || ''} ${inv.location || ''}`, geo)) return `outside the ${geo.country}`;
  if (audienceOf(inv) === 'experts') {
    if (isNotFundraisingExpert(inv)) return 'not a fundraising expert';
    // the AI said "not an expert": only trust it when nothing they publish says they raise money
    if ((inv.tags || []).includes('Not a fundraising expert') && !looksLikeFundraiser(inv)) return 'not a fundraising expert';
  }
  return '';
}
