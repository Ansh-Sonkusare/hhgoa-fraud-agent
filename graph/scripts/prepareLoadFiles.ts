#!/usr/bin/env tsx
/**
 * graph/scripts/prepareLoadFiles.ts — WS1: derive the entity/edge CSVs under
 * graph/build/ from data/*.csv, for the GSQL LOADING JOBs.
 *
 * Cardinal derivation (documented honestly, see graph/README.md):
 *   - Card id = `C<card1>-K<rank>`, rank assigned WITHIN a card1 group by
 *     ascending transaction count (fewest txns = K1). Measured ~61% exact
 *     match against closed-case card ids; the rest are honest approximations.
 *   - Cards referenced only by closed_cases_history/case_pack are emitted as
 *     stub Card vertices (is_stub=true).
 *   - Identity id = hash(card1, addr1, est-first-txn-day); Device id =
 *     hash(DeviceInfo, id_30, id_31, id_33). Both derived per PRD §16.
 *
 * Usage:
 *   tsx graph/scripts/prepareLoadFiles.ts [--max-transactions N] [--out-dir graph/build] [--data-dir ../../data]
 *
 * The reader supports the RFC 4180 subset (quoted fields, embedded commas,
 * newlines in quotes); transaction rows are parsed streaming.
 */
import { existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { eachRow, CsvWriter } from "./lib/csv.js";

const dataDirArg = process.argv.indexOf("--data-dir");
const dataDirValue = dataDirArg >= 0 ? process.argv[dataDirArg + 1] : undefined;
const dataDir = path.resolve(dataDirValue ?? path.join(import.meta.dirname, "../../data"));
const outDirArg = process.argv.indexOf("--out-dir");
const outDirValue = outDirArg >= 0 ? process.argv[outDirArg + 1] : undefined;
const outDir = path.resolve(outDirValue ?? path.join(import.meta.dirname, "../build"));
const maxTxnsArg = process.argv.indexOf("--max-transactions");
const maxTxns = maxTxnsArg >= 0 ? Number(process.argv[maxTxnsArg + 1]) : Infinity;

mkdirSync(outDir, { recursive: true });

const md5 = (s: string): string => createHash("md5").update(s, "utf-8").digest("hex").slice(0, 16);

// Transactions.csv column indices (docs/DATA_MAP.md + header scan).
const COL = {
  TransactionID: 0,
  TransactionAmt: 2,
  ProductCD: 3,
  card1: 4,
  card2: 5,
  card3: 6,
  card4: 7,
  card5: 8,
  card6: 9,
  addr1: 10,
  addr2: 11,
  dist1: 12,
  dist2: 13,
  P_emaildomain: 14,
  R_emaildomain: 15,
  C: 16, // C1..C14 -> C + i
  D: 30, // D1..D15 -> D + i
  M: 45, // M1..M9  -> M + i
  customer_id: 393,
  ts: 394,
  channel: 395,
  risk_score: 396,
};
// Identity.csv: TransactionID=0, id_01=1..id_11=11, id_15=15, id_23=23,
// id_30=30, id_31=31, id_33=33, id_34=34, DeviceType=39, DeviceInfo=40.

const cardKey = (r: string[]): string => `${r[COL.card1]}|${r[COL.card2]}|${r[COL.card3]}|${r[COL.card5]}`;

function tsEpoch(ts: string | undefined): number {
  if (!ts) return 0;
  const t = new Date(ts.replace(" ", "T"));
  return Number.isNaN(t.getTime()) ? 0 : t.getTime();
}

// ---------------------------------------------------------------------------
// Pass 0: identity.csv -> device map + device vertex rows
// ---------------------------------------------------------------------------
interface DeviceRow {
  id: string;
  deviceType: string;
  deviceInfo: string;
  os: string;
  browser: string;
  screen: string;
}
const identityByTxn = new Map<string, { deviceId: string }>();
const devices = new Map<string, DeviceRow>();
const devW = new CsvWriter(path.join(outDir, "devices.csv"));
devW.write(["id", "device_type", "device_info", "os", "browser", "screen"]);
async function loadIdentity(): Promise<void> {
  let n = 0;
  await eachRow(path.join(dataDir, "identity.csv"), (r) => {
    if (n === 0) {
      n += 1; // header
      return;
    }
    n += 1;
    const tid = r[0] ?? "";
    const devInfo = r[40] ?? "";
    const os = r[30] ?? "";
    const browser = r[31] ?? "";
    const screen = r[33] ?? "";
    const deviceId = md5(`${devInfo}|${os}|${browser}|${screen}`);
    identityByTxn.set(tid, { deviceId });
    if (!devices.has(deviceId)) {
      devices.set(deviceId, {
        id: deviceId,
        deviceType: r[39] ?? "",
        deviceInfo: devInfo,
        os,
        browser,
        screen,
      });
      devW.write([deviceId, r[39] ?? "", devInfo, os, browser, screen]);
    }
  });
  console.log(`[prepareLoadFiles] identity: ${n - 1} rows, ${devices.size} devices`);
}
await loadIdentity();
await devW.done();

// ---------------------------------------------------------------------------
// Pass A: transaction scan -> card metadata, identities, first-day keys
// ---------------------------------------------------------------------------
interface CardMeta {
  key: string;
  card1: string;
  count: number;
  firstTs: string;
  lastTs: string;
  firstEpoch: number;
  network: string;
  type: string;
  total: number;
  customers: Map<string, number>;
}
const cardMeta = new Map<string, CardMeta>();
const comboDay = new Map<string, string>(); // card1|addr1 -> min first day (YYYY-MM-DD)
const comboCardSet = new Map<string, Set<string>>(); // card1|addr1 -> card keys
const addr2ByAddr1 = new Map<string, string>();
const emailDomains = new Set<string>();
let txnCountA = 0;

function good(s: string | undefined): s is string {
  return !!s && s.trim() !== "";
}

await eachRow(path.join(dataDir, "transactions.csv"), (r) => {
  if (txnCountA === 0) {
    txnCountA += 1; // header
    return;
  }
  if (txnCountA - 1 >= maxTxns) return;
  txnCountA += 1;
  const k = cardKey(r);
  const ts = r[COL.ts] ?? "";
  const epoch = tsEpoch(ts);
  const prior = cardMeta.get(k);
  const m: CardMeta = prior ?? {
    key: k,
    card1: r[COL.card1] ?? "",
    count: 0,
    firstTs: ts,
    lastTs: ts,
    firstEpoch: epoch,
    network: r[COL.card4] ?? "",
    type: r[COL.card6] ?? "",
    total: 0,
    customers: new Map(),
  };
  if (!prior) cardMeta.set(k, m);
  m.count += 1;
  m.total += Number(r[COL.TransactionAmt]) || 0;
  if (epoch !== 0 && (m.firstEpoch === 0 || epoch < m.firstEpoch)) {
    m.firstEpoch = epoch;
    m.firstTs = ts;
  }
  // Lexicographic compare works for ISO 'YYYY-MM-DD HH:MM:SS'.
  if (good(ts) && (m.firstTs == null || ts < m.firstTs)) m.firstTs = ts;
  if (good(ts) && (m.lastTs == null || ts > m.lastTs)) m.lastTs = ts;
  if (r[COL.card4]) m.network = r[COL.card4] ?? "";
  if (r[COL.card6]) m.type = r[COL.card6] ?? "";
  const cust = r[COL.customer_id] ?? "";
  m.customers.set(cust, (m.customers.get(cust) ?? 0) + 1);

const a1 = r[COL.addr1];
    // Collect email domains from the SUBSET txns unconditionally: purchaser /
    // recipient email edges are emitted for every txn regardless of addr1, and
    // any referenced domain that is missing from email_domains.csv would be
    // auto-created as a placeholder when its edge loads.
    if (good(r[COL.P_emaildomain])) emailDomains.add(r[COL.P_emaildomain] ?? "");
    if (good(r[COL.R_emaildomain])) emailDomains.add(r[COL.R_emaildomain] ?? "");
    if (good(a1)) {
      const day = (ts ?? "").slice(0, 10);
      const ck = `${r[COL.card1]}|${a1}`;
      if (good(day) && (!comboDay.has(ck) || day < comboDay.get(ck)!)) comboDay.set(ck, day);
      let s = comboCardSet.get(ck);
      if (!s) comboCardSet.set(ck, (s = new Set()));
      s.add(k);
      if (good(r[COL.addr2])) addr2ByAddr1.set(a1, r[COL.addr2] ?? "");
    }
  });
console.log(`[prepareLoadFiles] pass A: ${txnCountA - 1} txns, ${cardMeta.size} card tuples`);

// Card ids: rank per card1 by ascending count (then first ts, then key).
const byCard1 = new Map<string, CardMeta[]>();
for (const m of cardMeta.values()) {
  const list = byCard1.get(m.card1) ?? [];
  list.push(m);
  byCard1.set(m.card1, list);
}
const cardIdOf = new Map<string, string>(); // card tuple key -> C<card1>-K<rank>
for (const [c1, list] of byCard1) {
  list.sort((a, b) => a.count - b.count || a.firstEpoch - b.firstEpoch || (a.key < b.key ? -1 : 1));
  let rank = 0;
  for (const m of list) {
    rank += 1;
    cardIdOf.set(m.key, `C${c1}-K${rank}`);
  }
}

// Identity vertex rows + ids.
interface IdentityRow {
  id: string;
  card1: string;
  addr1: string;
  day: string;
  cardCount: number;
}
const identities = new Map<string, IdentityRow>();
const identityIdOfCombo = new Map<string, string>(); // card1|addr1 -> identity id (first day)
for (const [combo, day] of comboDay) {
  const [card1 = "", addr1 = ""] = combo.split("|");
  const cardCount = comboCardSet.get(combo)?.size ?? 0;
  const id = md5(`${card1}|${addr1}|${day}`);
  identities.set(id, { id, card1, addr1, day, cardCount });
  identityIdOfCombo.set(combo, id);
}
console.log(`[prepareLoadFiles] identities: ${identities.size}, email domains: ${emailDomains.size}`);

// ---------------------------------------------------------------------------
// Pass B: emit txn rows + edge accumulators
// ---------------------------------------------------------------------------
const AC = {
  owns: new Map<string, string>(), // cardId -> customer
  made: new Map<string, [string, string]>(),
  billedTo: new Set<string>(),
  purchaserEmail: new Set<string>(),
  recipientEmail: new Set<string>(),
  usedDevice: new Set<string>(),
  cardTxns: new Map<string, Array<[string, string]>>(), // cardId -> [[ts, txnId]]
  cardDevice: new Map<string, [number, string, string]>(),
  cardAddress: new Map<string, [number, string, string]>(),
  cardRecipientEmail: new Map<string, [number, string, string]>(),
  resolvesTo: new Set<string>(),
  customerMeta: new Map<string, { count: number; first: string; last: string; total: number }>(),
};
const seen = <T>(s: Set<T>, key: T): void => void s.add(key);

const custMeta = AC.customerMeta;
const bumpCust = (cust: string, ts: string, amt: number): void => {
  let m = custMeta.get(cust);
  if (!m) custMeta.set(cust, (m = { count: 0, first: ts, last: ts, total: 0 }));
  m.count += 1;
  m.total += amt;
  if (good(ts)) {
    if (!m.first || ts < m.first) m.first = ts;
    if (!m.last || ts > m.last) m.last = ts;
  }
};

const txnsW = new CsvWriter(path.join(outDir, "txns.csv"));
txnsW.write([
  "id", "ts", "amount_usd", "product_cd", "channel", "risk_score", "dist1", "dist2",
  "addr1", "addr2", "p_email_domain", "r_email_domain", "customer_id", "card_id",
  "c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10", "c11", "c12", "c13", "c14",
  "d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "d10", "d11", "d12", "d13", "d14", "d15",
  "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9",
  "id_01", "id_02", "id_03", "id_04", "id_05", "id_06", "id_07", "id_08", "id_09", "id_10", "id_11",
  "id_15", "id_23", "id_34",
]);

let passBRows = 0;
// Ids that actually get loaded as vertices from the txn subset. Case-derived
// edge files (about_txn / about_customer / flagged_txn) are filtered against
// these: an edge referencing an unloaded entity would make the loading job
// auto-create a placeholder vertex, silently inflating counts past 0/expected.
const loadedTxns = new Set<string>();
const loadedCustomers = new Set<string>();
await eachRow(path.join(dataDir, "transactions.csv"), (r) => {
  if (passBRows === 0) {
    passBRows += 1; // header
    return;
  }
  if (passBRows - 1 >= maxTxns) return;
  passBRows += 1;
  const k = cardKey(r);
  const cardId = cardIdOf.get(k)!;
  const m = cardMeta.get(k)!;
  const txnId = r[COL.TransactionID] ?? "";
  const ts = r[COL.ts] ?? "";
  const amt = Number(r[COL.TransactionAmt]) || 0;
  const cust = r[COL.customer_id] ?? "";
  loadedTxns.add(txnId);
  loadedCustomers.add(cust);
  const a1 = r[COL.addr1];

  txnsW.write([
    txnId, ts, amt ? String(Math.round(amt * 100) / 100) : "", r[COL.ProductCD] ?? "",
    r[COL.channel] ?? "", r[COL.risk_score] ?? "", r[COL.dist1] ?? "", r[COL.dist2] ?? "",
    a1 ?? "", r[COL.addr2] ?? "", r[COL.P_emaildomain] ?? "", r[COL.R_emaildomain] ?? "",
    cust ?? "", cardId,
    ...(Array.from({ length: 14 }, (_, i) => r[COL.C + i] ?? "")),
    ...(Array.from({ length: 15 }, (_, i) => r[COL.D + i] ?? "")),
    ...(Array.from({ length: 9 }, (_, i) => r[COL.M + i] ?? "")),
    ...(Array.from({ length: 11 }, (_, i) => r[1 + i] ?? "")), // id_01..id_11
    r[15] ?? "", r[23] ?? "", r[34] ?? "", // id_15, id_23, id_34
  ]);

  if (!AC.made.has(txnId)) AC.made.set(txnId, [cardId, ts]);
  bumpCust(cust, ts, amt);
  const curCust = AC.owns.get(cardId);
  const custCount = m.customers.get(cust) ?? 0;
  if (!curCust || (m.customers.get(curCust ?? "") ?? 0) < custCount) AC.owns.set(cardId, cust);

  if (good(a1)) {
    seen(AC.billedTo, `${txnId}|${a1}`);
    const comboC1a1 = `${m.card1}|${a1}`;
    const idId = identityIdOfCombo.get(comboC1a1);
    if (idId) seen(AC.resolvesTo, `${cardId}|${idId}`);
  }
  if (good(r[COL.P_emaildomain])) seen(AC.purchaserEmail, `${txnId}|${r[COL.P_emaildomain]}`);
  if (good(r[COL.R_emaildomain])) {
    seen(AC.recipientEmail, `${txnId}|${r[COL.R_emaildomain]}`);
    const dk = `${cardId}|${r[COL.R_emaildomain]}`;
    const agg = AC.cardRecipientEmail.get(dk);
    if (agg) {
      agg[0] += 1;
      if (ts < agg[1]) agg[1] = ts;
      if (ts > agg[2]) agg[2] = ts;
    } else {
      AC.cardRecipientEmail.set(dk, [1, ts, ts]);
    }
  }
  const dev = identityByTxn.get(txnId);
  if (dev) {
    seen(AC.usedDevice, `${txnId}|${dev.deviceId}`);
    const dk = `${cardId}|${dev.deviceId}`;
    const agg = AC.cardDevice.get(dk);
    if (agg) {
      agg[0] += 1;
      if (ts < agg[1]) agg[1] = ts;
      if (ts > agg[2]) agg[2] = ts;
    } else {
      AC.cardDevice.set(dk, [1, ts, ts]);
    }
  }
  if (good(a1)) {
    const dk = `${cardId}|${a1}`;
    const agg = AC.cardAddress.get(dk);
    if (agg) {
      agg[0] += 1;
      if (ts < agg[1]) agg[1] = ts;
      if (ts > agg[2]) agg[2] = ts;
    } else {
      AC.cardAddress.set(dk, [1, ts, ts]);
    }
  }
  let list = AC.cardTxns.get(cardId);
  if (!list) AC.cardTxns.set(cardId, (list = []));
  list.push([ts, txnId]);
});
await txnsW.done();
console.log(`[prepareLoadFiles] pass B: ${passBRows - 1} txns`);

// ---------------------------------------------------------------------------
// Emit entity files (customers, addresses, email domains, identities, cards)
// ---------------------------------------------------------------------------
const custW = new CsvWriter(path.join(outDir, "customers.csv"));
custW.write(["id", "first_seen_ts", "last_seen_ts", "txn_count", "total_amount_usd"]);
for (const [c, m] of AC.customerMeta) {
  custW.write([c, m.first ?? "", m.last ?? "", String(m.count), String(Math.round(m.total * 100) / 100)]);
}
await custW.done();

if (addr2ByAddr1.size > 0) {
  const addrW = new CsvWriter(path.join(outDir, "addresses.csv"));
  addrW.write(["id", "addr2"]);
  for (const [a1, a2] of addr2ByAddr1) addrW.write([a1, a2]);
  await addrW.done();
}

if (emailDomains.size > 0) {
  const emW = new CsvWriter(path.join(outDir, "email_domains.csv"));
  emW.write(["id"]);
  for (const d of [...emailDomains].sort()) emW.write([d]);
  await emW.done();
}

const idW = new CsvWriter(path.join(outDir, "identities.csv"));
idW.write(["id", "card1", "addr1", "est_first_day", "card_count"]);
for (const x of identities.values()) idW.write([x.id, x.card1, x.addr1, x.day, String(x.cardCount)]);
await idW.done();

const cardW = new CsvWriter(path.join(outDir, "cards.csv"));
cardW.write([
  "id", "customer_id", "card_network", "card_type", "card1", "card2", "card3", "card5",
  "first_seen_ts", "last_seen_ts", "txn_count", "total_amount_usd", "is_stub",
]);
const cardIdsDerived = new Set<string>();
for (const m of cardMeta.values()) {
  const id = cardIdOf.get(m.key)!;
  cardIdsDerived.add(id);
  cardW.write([
    id, AC.owns.get(id) ?? "", m.network, m.type, m.card1,
    m.key.split("|")[1] ?? "", m.key.split("|")[2] ?? "", m.key.split("|")[3] ?? "",
    m.firstTs, m.lastTs, String(m.count), String(Math.round(m.total * 100) / 100), "false",
  ]);
}
await cardW.done();

// ---------------------------------------------------------------------------
// Emit edge files
// ---------------------------------------------------------------------------
const eW = (name: string): CsvWriter => new CsvWriter(path.join(outDir, name));
const ownsW = eW("owns.csv");
ownsW.write(["customer_id", "card_id"]);
for (const [cardId, cust] of AC.owns) ownsW.write([cust, cardId]);
await ownsW.done();

const madeW = eW("made.csv");
madeW.write(["card_id", "txn_id", "ts"]);
for (const [txnId, [cardId, ts]] of AC.made) madeW.write([cardId, txnId, ts]);
await madeW.done();

const nextW = eW("next.csv");
nextW.write(["txn_prev", "txn_next", "card_id", "gap_seconds"]);
let nextN = 0;
for (const [cardId, txns] of AC.cardTxns) {
  const sorted = txns.sort((a, b) => a[0].localeCompare(b[0]));
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (!prev || !cur) continue;
    const gap = Math.round((tsEpoch(cur[0]) - tsEpoch(prev[0])) / 1000);
    nextW.write([prev[1], cur[1], cardId, String(gap)]);
    nextN += 1;
  }
}
await nextW.done();
console.log(`[prepareLoadFiles] NEXT edges: ${nextN}`);

const btW = eW("billed_to.csv");
btW.write(["txn_id", "addr1"]);
for (const x of AC.billedTo) btW.write(x.split("|"));
await btW.done();
const peW = eW("purchaser_email.csv");
peW.write(["txn_id", "domain"]);
for (const x of AC.purchaserEmail) peW.write(x.split("|"));
await peW.done();
const reW = eW("recipient_email.csv");
reW.write(["txn_id", "domain"]);
for (const x of AC.recipientEmail) reW.write(x.split("|"));
await reW.done();
const udW = eW("used_device.csv");
udW.write(["txn_id", "device_id"]);
for (const x of AC.usedDevice) udW.write(x.split("|"));
await udW.done();

const rsW = eW("resolves_to.csv");
rsW.write(["card_id", "identity_id"]);
for (const x of AC.resolvesTo) rsW.write(x.split("|"));
await rsW.done();

const cdW = eW("card_device.csv");
cdW.write(["card_id", "device_id", "n", "first_ts", "last_ts"]);
for (const [k, [n, f, l]] of AC.cardDevice) cdW.write([...k.split("|"), String(n), f, l]);
await cdW.done();
const caW = eW("card_address.csv");
caW.write(["card_id", "addr1", "n", "first_ts", "last_ts"]);
for (const [k, [n, f, l]] of AC.cardAddress) caW.write([...k.split("|"), String(n), f, l]);
await caW.done();
const crW = eW("card_recipient_email.csv");
crW.write(["card_id", "domain", "n", "first_ts", "last_ts"]);
for (const [k, [n, f, l]] of AC.cardRecipientEmail) crW.write([...k.split("|"), String(n), f, l]);
await crW.done();

// ---------------------------------------------------------------------------
// Closed cases + case pack -> FraudCase / CasePackEntry + case edges
// ---------------------------------------------------------------------------
const stubRefs = new Map<string, string>(); // cardId -> customerId for stub cards

const fcW = eW("fraud_cases.csv");
fcW.write([
  "id", "status", "verdict", "fraud_probability", "pattern", "pattern_description",
  "exposure_usd", "opened_at", "closed_at", "outcome", "summary", "source",
  "report_filed", "analyst_notes", "first_fraud_txn_id", "n_txns", "embedding",
]);

const aboutTxnW = eW("about_txn.csv");
aboutTxnW.write(["case_id", "txn_id", "ts"]);
const aboutCardW = eW("about_card.csv");
aboutCardW.write(["case_id", "card_id", "ts"]);
const aboutCustW = eW("about_customer.csv");
aboutCustW.write(["case_id", "customer_id", "ts"]);
const connW = eW("connected_to.csv");
connW.write(["case_id", "card_id", "role"]);

let caseCnt = 0;
await eachRow(path.join(dataDir, "closed_cases_history.csv"), (r) => {
  if (caseCnt === 0) {
    caseCnt += 1;
    return;
  }
  caseCnt += 1;
  const [
    caseId = "", customerId = "", cardId = "", openedAt = "", closedAt = "", outcome = "",
    pattern = "", firstFraudTxnId = "", txnIds = "", nTxns = "", exposureUsd = "",
    connectedCardIds = "", actionsTaken = "", reportFiled = "", analystNotes = "",
  ] = r;
  const fraud = outcome === "confirmed_fraud";
  fcW.write([
    caseId, "closed", fraud ? "confirmed_fraud" : "cleared", fraud ? "1.0" : "0.0",
    pattern, "", exposureUsd ?? "", openedAt ?? "", closedAt ?? "", outcome ?? "",
    "", "closed_case", reportFiled?.toLowerCase() === "yes" || reportFiled?.toLowerCase() === "y"
      ? "true" : "false",
    analystNotes ?? "", firstFraudTxnId ?? "", nTxns ?? "", "",
  ]);
  // About edges capture the triggered transaction(s) — only for txns that are
  // actually loaded (subset builds would otherwise auto-create placeholders).
  for (const t of (txnIds ?? "").split("|")) {
    if (good(t) && loadedTxns.has(t)) aboutTxnW.write([caseId, t, openedAt ?? ""]);
  }
  if (good(customerId) && loadedCustomers.has(customerId)) {
    aboutCustW.write([caseId, customerId, openedAt ?? ""]);
  }
  if (good(cardId)) {
    aboutCardW.write([caseId, cardId, openedAt ?? ""]);
    if (!cardIdsDerived.has(cardId)) {
      stubRefs.set(cardId, customerId ?? "");
    }
  }
  for (const c of (connectedCardIds ?? "").split("|")) {
    if (good(c)) {
      connW.write([caseId, c, "connected"]);
      if (!cardIdsDerived.has(c)) stubRefs.set(c, customerId ?? "");
    }
  }
});
console.log(`[prepareLoadFiles] closed cases: ${caseCnt - 1}`);
await fcW.done();
await aboutTxnW.done();
await aboutCardW.done();
await aboutCustW.done();
await connW.done();

const cpeW = eW("case_pack_entries.csv");
cpeW.write([
  "id", "opened_at", "trigger_type", "trigger_text", "flagged_txn_id",
  "card_id", "customer_id", "risk_score",
]);
const flagW = eW("flagged_txn.csv");
flagW.write(["case_pack_id", "txn_id"]);
let packCnt = 0;
await eachRow(path.join(dataDir, "case_pack.csv"), (r) => {
  if (packCnt === 0) {
    packCnt += 1;
    return;
  }
  packCnt += 1;
  const [caseId = "", openedAt = "", triggerType = "", triggerText = "", flaggedTxnId = "",
    cardId = "", customerId = "", riskScore = ""] = r;
  cpeW.write([
    caseId, openedAt ?? "", triggerType ?? "", triggerText ?? "", flaggedTxnId ?? "",
    cardId ?? "", customerId ?? "", riskScore ?? "",
  ]);
  if (good(flaggedTxnId) && loadedTxns.has(flaggedTxnId)) flagW.write([caseId, flaggedTxnId]);
  if (good(cardId) && !cardIdsDerived.has(cardId)) {
    stubRefs.set(cardId, customerId ?? "");
  }
});
await cpeW.done();
await flagW.done();

{
  const stubW = eW("stub_cards.csv");
  stubW.write([
    "id", "customer_id", "card_network", "card_type", "card1", "card2", "card3", "card5",
    "first_seen_ts", "last_seen_ts", "txn_count", "total_amount_usd", "is_stub",
  ]);
  for (const [id, custId] of stubRefs) {
    stubW.write([id, custId, "", "", "", "", "", "", "", "", "0", "0", "true"]);
  }
  await stubW.done();
}

console.log(`[prepareLoadFiles] case_pack: ${packCnt - 1}; stub cards: ${stubRefs.size}`);
console.log(`[prepareLoadFiles] done -> ${outDir}`);