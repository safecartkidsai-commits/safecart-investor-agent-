/**
 * Keeps searches SHORT, so they actually return people.
 * Google only returns pages that contain EVERY quoted phrase, so a search like
 *   site:linkedin.com/in "fundraising consultant" "consumer apps" "Arizona" "success fee" "United States"
 * finds nobody. Fees, compliance words, "contact us" phrases etc. don't belong in searches — the agent
 * checks fees and location AFTER finding people.
 */
import type { Audience } from './audience';

/** Phrases that never help a search: fee terms, jargon, "contact" wording, "LinkedIn" itself. */
const NOISE =
  /^(success[- ]?fee( model)?|success[- ]based( compensation)?|commission( based)?|commission[- ]only|no retainer|no upfront fees?|performance[- ]based|performance compensation|equity( only| compensation)?|coppa|deal flow|intro(duction)?s? to investors|investor introductions|angel syndicate|book a (call|discovery call)|schedule a (call|meeting)|contact( me| us)?|email( us)?|reach out|get in touch|let's talk|linkedin|blog post|case studies?|list of .*|directory of .*|top .*|community of .*)$/i;

const PLACE =
  /^(usa|united states|america|arizona|phoenix|scottsdale|chandler|tempe|mesa|tucson|dallas|austin|houston|texas|atlanta|georgia|new york|nyc|san francisco|bay area|silicon valley|los angeles|california|boston|seattle|chicago|miami|florida|denver|colorado|salt lake city|utah|san diego|washington|dc|nashville|raleigh|philadelphia|minneapolis|portland|las vegas|charlotte|detroit|pittsburgh|columbus|baltimore|new jersey)$/i;

/** Shorten one search: keep site:, the first useful phrase (role) and ONE more (a theme OR a place). */
export function simplifyQuery(q: string): string {
  const site = (q.match(/site:\S+/i) || [''])[0];
  const allQuoted = [...q.matchAll(/"([^"]+)"/g)].map(m => m[1].trim()).filter(Boolean);
  // long quoted sentences ("list of fundraising consultants for …") become plain words instead
  const loose = allQuoted.filter(p => p.split(/\s+/).length >= 4).flatMap(p => p.replace(/^(list|directory|community) of\s+/i, '').replace(/^top\s+/i, '').split(/\s+/));
  const quoted = allQuoted.filter(p => p.split(/\s+/).length < 4);
  const rest = [...loose, ...q
    .replace(/site:\S+/gi, ' ')
    .replace(/"[^"]*"/g, ' ')
    .replace(/\b(OR|AND)\b/g, ' ')
    .split(/\s+/)]
    .filter(Boolean);
  const useful = quoted.filter(p => !NOISE.test(p));
  const places = useful.filter(p => PLACE.test(p));
  const topics = useful.filter(p => !PLACE.test(p));
  const restPlaces = rest.filter(w => PLACE.test(w));
  const restWords = rest.filter(w => !PLACE.test(w) && !NOISE.test(w) && w.length > 1);
  const parts: string[] = [];
  if (site) parts.push(site);
  if (topics[0]) parts.push(`"${topics[0]}"`);
  const place = places[0] || restPlaces[0] || '';
  if (site) {
    if (place) parts.push(`"${place}"`);
    else if (topics[1]) parts.push(`"${topics[1]}"`);
  } else {
    // web searches: a few plain words are fine, the place stays unquoted
    if (!place && topics[1]) parts.push(`"${topics[1]}"`);
    parts.push(...restWords.filter(w => !/^(fee|fees|success|commission|retainer|coppa)$/i.test(w)).slice(0, topics[0] ? 3 : 6));
    if (place) parts.push(place);
  }
  const out = parts.join(' ').replace(/\s+/g, ' ').trim();
  return out.replace(/^site:\S+$/i, '') || q.trim();
}

const INVESTOR_ROLES = ['angel investor', 'pre-seed investor', 'seed investor', 'early stage investor', 'venture partner', 'angel investor consumer'];
const EXPERT_ROLES = ['fundraising consultant', 'fundraising advisor', 'capital raising advisor', 'startup fundraising consultant', 'investor relations consultant', 'fundraising partner'];

/** US startup hubs — your own state first. */
function places(homeCity: string, homeState: string): string[] {
  const hubs = ['Phoenix', 'Scottsdale', 'Arizona', 'New York', 'San Francisco', 'Los Angeles', 'Austin', 'Dallas', 'Houston', 'Boston', 'Seattle', 'Chicago', 'Miami', 'Denver', 'Atlanta', 'Salt Lake City', 'San Diego', 'Nashville', 'Raleigh', 'Philadelphia', 'Minneapolis', 'Washington DC'];
  return [...new Set([homeState, 'Phoenix', homeCity, ...hubs].filter(Boolean))];
}

/**
 * Simple, reliable searches (role + city), many combinations, no AI needed.
 * Returns ones not used before, so every run gets fresh searches.
 */
export function comboQueries(audience: Audience, used: Set<string>, count: number, homeCity = '', homeState = ''): string[] {
  const roles = audience === 'experts' ? EXPERT_ROLES : INVESTOR_ROLES;
  const out: string[] = [];
  for (const p of places(homeCity, homeState)) {
    for (const r of roles) {
      for (const q of [`site:linkedin.com/in "${r}" "${p}"`, `"${r}" ${p} startups`]) {
        if (!used.has(`${q}|1`.toLowerCase()) && !out.includes(q)) out.push(q);
        if (out.length >= count) return out;
      }
    }
  }
  return out;
}
