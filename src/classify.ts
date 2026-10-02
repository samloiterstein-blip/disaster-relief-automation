import type { Kind, Level, Status } from "./types.ts";
import { extractState } from "./states.ts";

export interface Classification {
  level: Level;
  kind: Kind;
  status: Status;
  state?: string;
}

const DECLARATION_PHRASE = new RegExp(
  [
    String.raw`state of (?:emergency|disaster|disaster emergency)`,
    String.raw`(?:local|disaster|public health|statewide|civil) emergency`,
    String.raw`(?:emergency|disaster) (?:declaration|proclamation|order)s?`,
    String.raw`declarations? of (?:a |an )?(?:local |state )?(?:emergency|disaster)`,
    String.raw`major disaster`,
    String.raw`fire management assistance`,
    String.raw`declar(?:e|es|ed|ing) (?:a |an |the )?(?:[\w-]+ ){0,2}(?:emergency|disaster)`,
    String.raw`emergency (?:was |has been |is )?declared`,
    String.raw`disaster (?:was |has been |is )?declared`,
  ].join("|"),
  "i",
);

const ACTION = /\b(?:declar\w*|issu(?:e|es|ed|ing)|sign(?:s|ed|ing)?|approv\w*|grant\w*|proclaim\w*|activat\w*|invok\w*|order(?:s|ed)?|authoriz\w*|receiv\w*|secur(?:e|es|ed|ing)|renew\w*|extend\w*)\b/i;
// Base forms ("urges FEMA to approve") are requests, so only inflected forms count as granted.
const GRANTED = /\b(?:approv(?:es|ed|al)|grant(?:s|ed)|receiv(?:es|ed)|award(?:s|ed)|secur(?:es|ed)|declares|declared)\b/i;
const REQUEST = /\b(?:request\w*|seek\w*|sought|ask(?:s|ed|ing)?|submit\w*|appeal\w*|urg(?:e|es|ed|ing)|call(?:s|ed|ing)? (?:on|for|upon))\b/i;
const AMEND = /\b(?:expand\w*|amend\w*|supplement(?:al|ary)|add(?:s|ed|ing)? (?:\w+ )?(?:counties|parishes|areas)|additional (?:counties|parishes|areas))\b/i;
const ORDINAL = String.raw`(?:(?:twenty|thirty|forty|fifty|sixty)[-\s](?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|\w+teenth|\w+tieth|(?!1st)\d+(?:st|nd|rd|th))`;
// Texas renews standing proclamations monthly; Hawaii and Alabama number them ("Tenth Proclamation", "Second Supplemental State of Emergency").
const RENEW = new RegExp(
  String.raw`\b(?:renew\w*|extend\w*|extension|continu\w*|${ORDINAL}\s+(?:supplement(?:al|ary)\s+|amended\s+)?(?:proclamation|state of emergency|emergency|declaration|executive order))\b`,
  "i",
);
const SBA = /\b(?:small business administration|sba)\b/i;

const NEGATIVE = [
  /\b(?:lift\w*|rescind\w*|end(?:s|ed|ing)?|expir\w*|terminat\w*|revok\w*|conclud\w*)\b[^.]{0,40}\b(?:state of (?:civil |public health |disaster )?emergency|emergency declaration|disaster declaration|emergency order|public health emergency)/i,
  // Explainers and process pages ("Federal Disaster Declaration Process", "How does a disaster declaration work?").
  /\b(?:declaration process|process (?:for|of) (?:a |an )?(?:disaster|emergency) declarations?|how (?:to|does|do|a)\b|faqs?|frequently asked|guide to)\b/i,
  // National Emergencies Act declarations (tariffs, sanctions, the power grid) aren't disasters.
  /\bnational emergency\b/i,
  /\b(?:anniversary|years? (?:ago|after|later|since))\b/i,
  /\b(?:denied|denies|rejects?|rejected|turns? down)\b[^.]{0,40}\bdeclaration/i,
  /\bemergency (?:room|department|operations? (?:center|plan)|management (?:agency|director|office)|alerts?|warnings?|sirens?|notifications?|services|medical|responders?|vehicles?|communications|preparedness|shelters?|funding|grants?)\b(?![^.]{0,60}\b(?:declar|state of emergency))/i,
  // Meetings, proposals, and speculation about a declaration aren't one.
  /\b(?:possible|potential|proposed|consider\w*|weigh\w*|mull\w*|discuss\w*|meet\w* on|could|may|might)\b[^.]{0,25}\b(?:disaster|emergency) (?:declaration|proclamation)s?\b/i,
  // Pilots "declare an emergency" constantly; none of it is a disaster declaration.
  /\b(?:flight|plane|pilot|aircraft|airliner|airline|jet|squawk\w*|mayday|emergency landing|cockpit|passengers?|medical emergency)\b/i,
];

/** Wording that places an item in the U.S. when no state could be identified. */
const US_SIGNAL = /\b(?:county|counties|parish(?:es)?|borough|township|governor|gov\.|mayor|supervisors|commissioners|city council|fema|stafford act|local emergency|national guard|white house)\b/i;
const NON_US = /\b(?:nigeria|kenya|ghana|uganda|tanzania|zambia|zimbabwe|south africa|india|pakistan|bangladesh|sri lanka|nepal|philippines|indonesia|malaysia|vietnam|thailand|australia|new zealand|canada|canadian|ontario|quebec|british columbia|alberta|manitoba|saskatchewan|nova scotia|britain|england|scotland|wales|ireland|u\.k\.|europe|spain|italy|france|germany|greece|turkey|ukraine|russia|israel|gaza|lebanon|syria|iraq|iran|saudi|dubai|uae|qatar|china|japan|taiwan|korea|(?<!new )mexico|brazil|peru|chile|argentina|colombia|venezuela|cuba|haiti|jamaica)\b/i;

const FEDERAL = /\b(?:fema|presidential|white house|stafford act|major disaster|federal (?:disaster|emergency) declaration|fire management assistance|feds|usda|agriculture secretary|secretarial (?:disaster )?designation)\b/i;
/** USDA drought/crop designations: federal, but not Stafford Act declarations. */
const AGRICULTURAL = /\b(?:usda|agriculture secretary|secretarial (?:disaster )?designation)\b/i;
const PRESIDENT_ACTS = /\b(?:president|trump)\b[^.]{0,60}\b(?:approv\w*|grant\w*|sign\w*|declar\w*)\b/i;
const LOCAL = /\b(?:county|counties|city|cities|town|village|borough|parish(?:es)?|township|mayor|supervisors|commissioners|council|municipal|local emergency|tribe|tribal|nation)\b/i;
const STATE = /\b(?:gov\.|governor|statewide|state of (?:emergency|disaster) (?:for|across|in) (?:the )?state)\b/i;

/**
 * Decide whether free text announces a disaster/emergency declaration.
 * Returns null when it does not look like one.
 */
export function classify(text: string, hints: { level?: Level; state?: string } = {}): Classification | null {
  const t = text.replace(/\s+/g, " ");
  if (!DECLARATION_PHRASE.test(t)) return null;
  if (NEGATIVE.some((re) => re.test(t))) return null;

  const hasAction = ACTION.test(t) || /\bdeclared\b/i.test(t);
  // Judge request-vs-granted on the headline when there is one; summaries often recap the original request.
  const headline = t.split(/(?<!\b(?:Gov|Lt|Gen|Sen|Rep|St|Mt|Ft|No|Dr|Mr|Mrs|Ms|U\.S|D\.C))\.\s/)[0];
  const isRequest = REQUEST.test(headline) ? !GRANTED.test(headline) : REQUEST.test(t) && !GRANTED.test(t);
  if (!hasAction && !isRequest) return null;

  const state = hints.state ?? extractState(t);
  if (!state && !hints.level && (NON_US.test(t) || !US_SIGNAL.test(t))) return null;

  const status: Status = isRequest ? "requested" : RENEW.test(headline) ? "renewed" : AMEND.test(t) ? "amended" : "declared";

  // The hint (e.g. "this is a governor's feed") outranks local wording but not
  // explicit federal language such as a governor requesting a FEMA declaration.
  let level: Level;
  if (FEDERAL.test(t) || PRESIDENT_ACTS.test(t) || SBA.test(headline)) level = "federal";
  else if (hints.level) level = hints.level;
  else if (STATE.test(t)) level = "state";
  else if (LOCAL.test(t)) level = "local";
  else level = "state";

  let kind: Kind;
  if (/fire management assistance/i.test(t)) kind = "fire_management";
  else if (AGRICULTURAL.test(t) && !/\b(?:fema|presidential|major disaster|stafford act)\b/i.test(t)) kind = "other";
  else if (SBA.test(headline) && !/\b(?:fema|presidential|major disaster|stafford act)\b/i.test(headline)) kind = "sba_disaster";
  else if (level === "federal" && /major disaster/i.test(t)) kind = "major_disaster";
  else if (level === "federal") kind = /emergency declaration|emergency/i.test(t) ? "emergency" : "major_disaster";
  else if (level === "local") kind = "local_emergency";
  else kind = "state_emergency";

  return { level, kind, status, state };
}

/**
 * For sources that only list declarations, where item titles ("Robin Lane Sewage Spill") don't say so.
 * Returns null for terminations and other items the classifier rejects outright.
 */
export function assumedDeclaration(title: string, level: Level = "state", state?: string): Classification | null {
  if (NEGATIVE.some((re) => re.test(title)) || /\b(?:terminat\w*|rescind\w*|rescission|lift\w*|expir\w*)\b/i.test(title)) return null;
  return {
    level,
    kind: level === "local" ? "local_emergency" : level === "federal" ? "emergency" : "state_emergency",
    status: RENEW.test(title) ? "renewed" : AMEND.test(title) ? "amended" : "declared",
    state,
  };
}

const STOPWORDS = new Set(
  "a an and the of for in on to at by with from as is are was were be has have after over amid due new this that its it his her their gov governor declares declared declaring declare state emergency disaster declaration says said".split(" "),
);

/** Normalized token set used for fuzzy duplicate detection across sources. */
export function tokenize(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/\s+-\s+[^-]+$/, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return [...new Set(words)];
}

export function similarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const inter = a.filter((w) => setB.has(w)).length;
  return inter / (a.length + b.length - inter);
}
