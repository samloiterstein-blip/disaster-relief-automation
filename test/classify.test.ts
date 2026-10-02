import assert from "node:assert/strict";
import { test } from "node:test";
import { assumedDeclaration, classify } from "../src/classify.ts";
import { extractState } from "../src/states.ts";

test("detects state declarations from real headlines", () => {
  const cases: Array<[string, string | undefined, string]> = [
    ["Gov. Abbott declares disaster in Texas over high diesel prices, fuel shortage - KVUE", "TX", "state"],
    ["Greg Abbott Declares State Of Emergency Over High Diesel Prices - The Daily Wire", "TX", "state"],
    ["Governor Newsom proclaims state of emergency to bolster statewide El Nino preparedness", "CA", "state"],
    ["Ohio Governor declares State of Emergency - Morgan County Herald", "OH", "state"],
    ["Sanders Declares Emergency to Ease Diesel Costs for Arkansas Farmers and Loggers - arkansasbusiness.com", "AR", "state"],
  ];
  for (const [title, state, level] of cases) {
    const c = classify(title);
    assert.ok(c, title);
    assert.equal(c.state, state, title);
    assert.equal(c.level, level, title);
    assert.equal(c.status, "declared", title);
  }
});

test("renewals and extensions are 'renewed', not new declarations", () => {
  for (const title of [
    "Governor Abbott Renews Disaster Proclamation For Wildfire Risk",
    "Gov. Abbott renews state of emergency for border counties",
    "Governor Lombardo Extends Emergency Declaration for Flooding",
    "TENTH PROCLAMATION RELATING TO WILDFIRES: governor declares emergency",
    "Twenty-First Proclamation Relating to Housing Emergency declared by Governor Green",
  ]) {
    assert.equal(classify(title, { level: "state" })?.status, "renewed", title);
  }
  assert.equal(classify("Governor Moore Declares State of Emergency Ahead of Winter Storm")?.status, "declared");

  assert.equal(assumedDeclaration("Twenty-seventh Supplemental State of Emergency: Coronavirus (COVID-19)")?.status, "renewed");
  assert.equal(assumedDeclaration("Second Supplemental State of Emergency: Tropical Storm Sally")?.status, "renewed");
  assert.equal(assumedDeclaration("First Supplemental State of Emergency: Hurricane Ida")?.status, "amended");
  assert.equal(assumedDeclaration("State of Emergency: St. Clair County")?.status, "declared");
  assert.equal(assumedDeclaration("Termination of State of Emergency: Winter Weather"), null);
});

test("SBA declarations reported by state agencies are federal SBA declarations", () => {
  const c = classify("U.S. Small Business Administration Approves Disaster Declaration for April 17 Severe Storm and Tornado in Stephenson County", { level: "state", state: "IL" });
  assert.equal(c?.level, "federal");
  assert.equal(c?.kind, "sba_disaster");
});

test("wins and calls are judged on the headline", () => {
  const secured = classify("Gov. Gianforte Secures Major Disaster Declaration for Montana from Richard Spring Fire. The governor requested the declaration in August.");
  assert.equal(secured?.status, "declared");
  assert.equal(secured?.level, "federal");

  const calls = classify("Governor Gianforte Calls on Feds to Declare Drought Disaster Area in 11 Counties");
  assert.equal(calls?.status, "requested");
  assert.equal(calls?.level, "federal");

  assert.equal(classify("Slotkin Joins Michigan Delegation Urging Small Business Administration to Approve Disaster Declaration")?.status, "requested");
  assert.equal(classify("Governor Gianforte, Governors Call on President Biden To End Public Health Emergency"), null);
  assert.equal(classify("Declaring a National Emergency to Secure the United States Bulk-Power System", { level: "federal" }), null);

  assert.equal(classify("Rutherford County Siren Upgrades Included in $10.6M Statewide Emergency Alert Grant - WGNS Radio"), null);
  assert.equal(classify("City of Clovis, Curry County commissioners meet on possible disaster declaration - MyHighPlains.com"), null);
  assert.equal(classify("More than half of Michigan could get April disaster declaration - Brownfield Ag News"), null);

  const usda = classify("Wyoming Receives USDA Disaster Declaration for Wildfire Impacts");
  assert.equal(usda?.kind, "other");
});

test("detects local declarations", () => {
  const c = classify("State of Emergency Declared for Washington County Following Flooding - KCII Radio Washington, Iowa");
  assert.equal(c?.level, "local");
  assert.equal(c?.state, "IA");

  const salinas = classify("Salinas declares local emergency ahead of potential El Niño - ksbw.com");
  assert.equal(salinas?.level, "local");
});

test("detects federal approvals and requests", () => {
  const approved = classify("President Trump approves major disaster declaration for Iowa after flooding");
  assert.equal(approved?.level, "federal");
  assert.equal(approved?.kind, "major_disaster");
  assert.equal(approved?.status, "declared");
  assert.equal(approved?.state, "IA");

  const requested = classify("Governor Ferguson requests federal emergency declaration for Washington wildfires");
  assert.equal(requested?.level, "federal");
  assert.equal(requested?.status, "requested");
  assert.equal(requested?.state, "WA");

  const received = classify(
    "West Virginia Receives Major Disaster Declaration from President Donald Trump. Governor Morrisey requested the declaration on Sept. 3.",
    { level: "state", state: "WV" },
  );
  assert.equal(received?.level, "federal");
  assert.equal(received?.status, "declared");

  const fmag = classify("FEMA authorizes fire management assistance for the Hydra Fire in Texas");
  assert.equal(fmag?.kind, "fire_management");
});

test("ignores non-declarations", () => {
  for (const title of [
    "Flydubai flight FZ1073 declares emergency after briefly transmitting 7500 code - cedarnews.net",
    "Why a Lufthansa flight declared an emergency landing over Scotland - The Independent",
    "Chinda Calls for Emergency Declaration Over Rivers Flooding - elanhub media",
    "Governor lifts state of emergency for Harris County as floodwaters recede",
    "Five years after the disaster declaration, Paradise rebuilds",
    "County opens new emergency operations center",
    "Governor Newsom signs bills to protect sexual assault survivors",
    "Federal Disaster Declaration Process",
    "Tennessee Awarded $10.6 Million Federal Grant to Strengthen Statewide Emergency Warning Systems",
    "Executive Order 40: An Order Providing an Orderly Transition Following the Termination of the State of Civil Emergency (PDF)",
  ]) {
    assert.equal(classify(title), null, title);
  }
});

test("governor feed hint keeps county-level wording at state level", () => {
  const c = classify("Declares State of Emergency for Lake and Mendocino Counties", { level: "state", state: "CA" });
  assert.equal(c?.level, "state");
  assert.equal(c?.state, "CA");
});

test("state extraction handles tricky names", () => {
  assert.equal(extractState("Flooding in West Virginia"), "WV");
  assert.equal(extractState("Storms hit Virginia"), "VA");
  assert.equal(extractState("New Mexico wildfire"), "NM");
  assert.equal(extractState("Washington County, Iowa flooding"), "IA");
  assert.equal(extractState("Salinas, California braces for El Niño"), "CA");
  assert.equal(extractState("Governor Newsom and Lee County officials"), "CA");
  assert.equal(extractState("Texas and Oklahoma storms"), undefined);
});
