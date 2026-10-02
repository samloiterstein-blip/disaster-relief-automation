import { readFileSync } from "node:fs";

export const STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  DC: "District of Columbia", PR: "Puerto Rico", GU: "Guam", VI: "U.S. Virgin Islands",
  AS: "American Samoa", MP: "Northern Mariana Islands",
  FM: "Federated States of Micronesia", MH: "Marshall Islands", PW: "Palau",
};

const NAME_PATTERNS: Array<[string, RegExp]> = Object.entries(STATES)
  .map(([code, name]): [string, string] => [code, name])
  // Longest names first so "West Virginia" wins over "Virginia".
  .sort((a, b) => b[1].length - a[1].length)
  .map(([code, name]) => [code, new RegExp(`\\b${name.replace(/[.]/g, "\\.?").replace(/ /g, "\\s+")}\\b`, "i")]);

const EXTRA_PATTERNS: Array<[string, RegExp]> = [
  ["VI", /\bvirgin islands\b/i],
  ["MP", /\bmariana islands\b/i],
  ["FM", /\bmicronesia\b/i],
  ["DC", /\bwashington,?\s+d\.?c\.?\b/i],
];

interface Governor {
  name: string;
  distinctive?: boolean;
}

const governors = JSON.parse(readFileSync(new URL("../config/governors.json", import.meta.url), "utf8")).governors as Record<string, Governor>;

const GOVERNOR_PATTERNS: Array<[string, RegExp]> = Object.entries(governors).map(([code, g]) => {
  const parts = g.name.split(/\s+/);
  const first = parts[0];
  const last = parts[parts.length - 1];
  // Case-sensitive on purpose: names are capitalized, and "Governor Newsom and Lee County" must not read as Gov. Lee.
  const alts = [`${first}\\s+(?:[A-Z][\\w'-]*\\s+)?${last}`, `(?:[Gg]ov\\.?|[Gg]overnor|GOV\\.?|GOVERNOR)\\s+(?:[A-Z][\\w'-]*\\s+){0,2}?${last}`];
  if (g.distinctive) alts.push(last);
  return [code, new RegExp(`\\b(?:${alts.join("|")})\\b`)];
});

const SUBDIVISION = /\b(?:[A-Z][a-z]+\s+){1,2}(?:County|Parish|Borough|Township)\b/g;

/** Best-effort state extraction from free text. Returns undefined when ambiguous or absent. */
export function extractState(text: string): string | undefined {
  // "Washington County" names a county, not a state.
  let remaining = text.replace(SUBDIVISION, " ");

  // "Salinas, California" style: a state after a comma is the strongest signal.
  const afterComma = new Set<string>();
  for (const [code, re] of NAME_PATTERNS) {
    if (new RegExp(`,\\s*${re.source}`, "i").test(remaining)) afterComma.add(code);
  }
  if (afterComma.size === 1) return [...afterComma][0];

  const found = new Set<string>();
  for (const [code, re] of GOVERNOR_PATTERNS) {
    if (re.test(remaining)) {
      found.add(code);
      remaining = remaining.replace(new RegExp(re.source, "g"), " ");
    }
  }
  for (const [code, re] of [...EXTRA_PATTERNS, ...NAME_PATTERNS]) {
    if (re.test(remaining)) {
      found.add(code);
      remaining = remaining.replace(new RegExp(re.source, "gi"), " ");
    }
  }
  if (found.size === 1) return [...found][0];
  return undefined;
}

export function stateName(code: string | null | undefined): string {
  return (code && STATES[code]) || "Unknown state";
}
