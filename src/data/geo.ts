/**
 * Where to look for people: the country (and state) of the business location in "Your App".
 * "Chandler, AZ" → United States, Arizona. The agent only keeps people based in that country.
 */
const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia'
};
const STATE_NAMES = Object.values(US_STATES);

export interface TargetGeo {
  country: string;
  isUS: boolean;
  state: string;
  city: string;
}

export function targetGeo(location?: string): TargetGeo {
  const loc = (location || '').trim();
  const parts = loc.split(',').map(x => x.trim()).filter(Boolean);
  const city = parts[0] || '';
  let state = '';
  for (const p of parts.slice(1)) {
    const up = p.replace(/\./g, '').toUpperCase();
    if (US_STATES[up]) state = US_STATES[up];
    const named = STATE_NAMES.find(n => n.toLowerCase() === p.toLowerCase());
    if (named) state = named;
  }
  const saysUS = /\b(usa|u\.s\.a?\.?|united states|america)\b/i.test(loc);
  if (state || saysUS || !loc) return { country: 'United States', isUS: true, state, city };
  // not in the US: use the last part of the location as the country
  return { country: parts[parts.length - 1] || 'United States', isUS: false, state: '', city };
}

/** One line for the AI: who to keep. */
export function geoRule(g: TargetGeo): string {
  return `LOCATION RULE: only include people / firms based in the ${g.country}${g.state ? ` (people in ${g.state} are a bonus)` : ''}. Skip anyone the evidence shows is based in another country. If the location is unknown, keep them only if nothing suggests they are outside the ${g.country}.`;
}

const US_HINT = new RegExp(`\\b(usa|united states|u\\.s\\.|america|${STATE_NAMES.join('|')})\\b`, 'i');

/** Make sure a search query is aimed at the target country (adds "United States" / USA when it names no place). */
export function withGeo(q: string, g: TargetGeo): string {
  if (g.isUS) {
    if (US_HINT.test(q)) return q;
    // unquoted, so it only nudges the search towards the USA instead of filtering everything out
    return /site:linkedin\.com/i.test(q) ? `${q} United States` : `${q} USA`;
  }
  return q.toLowerCase().includes(g.country.toLowerCase()) ? q : `${q} "${g.country}"`;
}

const NON_US = /\b(united kingdom|uk|england|london|scotland|ireland|dublin|canada|toronto|vancouver|montreal|india|bangalore|bengaluru|mumbai|delhi|pakistan|karachi|lahore|uae|dubai|abu dhabi|saudi|riyadh|qatar|israel|tel aviv|germany|berlin|munich|france|paris|netherlands|amsterdam|spain|madrid|barcelona|italy|milan|sweden|stockholm|switzerland|zurich|singapore|australia|sydney|melbourne|new zealand|nigeria|lagos|kenya|nairobi|south africa|egypt|cairo|brazil|são paulo|sao paulo|mexico|argentina|chile|colombia|japan|tokyo|china|beijing|shanghai|hong kong|korea|seoul|indonesia|jakarta|philippines|vietnam|turkey|istanbul|poland|ukraine|portugal|lisbon|denmark|norway|finland|belgium|austria|estonia)\b/i;

/** Does this location / country text clearly point outside the target country? */
export function outsideTarget(text: string | undefined, g: TargetGeo): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  if (g.isUS) return !US_HINT.test(t) && NON_US.test(t);
  return !t.toLowerCase().includes(g.country.toLowerCase()) && (US_HINT.test(t) || NON_US.test(t));
}
