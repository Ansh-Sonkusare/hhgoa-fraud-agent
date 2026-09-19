import { fileURLToPath } from "node:url";
import path from "node:path";
import { streamCsvObjects } from "./csv.js";

/** Device/address signal for one transaction, used to enrich case fingerprints. */
export interface TransactionSignal {
  txn_id: string;
  addr1: string;
  addr2: string;
  card_network: string; // card4
  card_type: string; // card6
  /** "DeviceInfo | OS | browser | screen", same convention as README's
   * worked example and `connected_device_profiles` in the answer format. */
  device_profile: string | null;
  device_is_new: boolean; // id_15 === "New"
  proxy_flag: string | null; // id_23
}

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "..", "..");
}

function dataPath(file: string): string {
  return path.join(repoRoot(), "data", file);
}

function buildDeviceProfile(row: Record<string, string>): string | null {
  const deviceInfo = row.DeviceInfo?.trim();
  const os = row.id_30?.trim();
  const browser = row.id_31?.trim();
  const screen = row.id_33?.trim();
  const parts = [deviceInfo, os, browser, screen].filter((p) => p && p.length > 0);
  if (parts.length === 0) return null;
  return parts.join(" | ");
}

/**
 * Single-pass streaming join over `transactions.csv` (708MB, ~590k rows)
 * and `identity.csv` (~144k rows, online txns only) for a bounded set of
 * `TransactionID`s. We never load either file fully into memory — that's
 * DuckDB/WS1 territory (PRD §7's `get_wide_features`) — we only pull the
 * few address/device columns a case fingerprint needs (PRD §11: "amounts
 * band, device/address signals"), and only for the txn ids the caller
 * actually asks for (closed-case `first_fraud_txn_id`s + case-pack flagged
 * txns — thousands, not hundreds of thousands).
 */
export async function getTransactionSignals(
  txnIds: ReadonlySet<string>,
): Promise<Map<string, TransactionSignal>> {
  const out = new Map<string, TransactionSignal>();
  if (txnIds.size === 0) return out;

  const remaining = new Set(txnIds);
  for await (const row of streamCsvObjects(dataPath("transactions.csv"))) {
    const id = row.TransactionID;
    if (!id || !remaining.has(id)) continue;
    out.set(id, {
      txn_id: id,
      addr1: row.addr1 ?? "",
      addr2: row.addr2 ?? "",
      card_network: row.card4 ?? "",
      card_type: row.card6 ?? "",
      device_profile: null,
      device_is_new: false,
      proxy_flag: null,
    });
    remaining.delete(id);
    if (remaining.size === 0) break;
  }

  // Second pass: identity.csv (online txns only) for device signals, only
  // for the txn ids we actually found in transactions.csv.
  const needIdentity = new Set(out.keys());
  if (needIdentity.size > 0) {
    for await (const row of streamCsvObjects(dataPath("identity.csv"))) {
      const id = row.TransactionID;
      if (!id || !needIdentity.has(id)) continue;
      const existing = out.get(id);
      if (existing) {
        existing.device_profile = buildDeviceProfile(row);
        existing.device_is_new = (row.id_15 ?? "").trim() === "New";
        existing.proxy_flag = row.id_23?.trim() || null;
      }
      needIdentity.delete(id);
      if (needIdentity.size === 0) break;
    }
  }

  return out;
}
