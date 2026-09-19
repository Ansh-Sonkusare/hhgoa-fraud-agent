import type { LookupExternal } from "@hhgoa/contracts";
import { envelope, NO_AS_OF } from "./envelope.js";

/**
 * `lookup_external` (PRD §8.4: "static/mock enrichment, labelled
 * external"). There is no live threat-intel/geo-IP service wired up in
 * this environment (and the brief explicitly calls for mock/static
 * enrichment, not a real vendor integration) — every classification below
 * is a small deterministic heuristic table, clearly labeled as such in the
 * `note` field so the agent/explainer never mistakes it for a verified
 * external signal. No `as_of` per the contract signature (static
 * reference data, not time-bearing).
 */
const FREE_WEBMAIL_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "aol.com",
  "icloud.com",
  "live.com",
  "protonmail.com",
  "msn.com",
]);

const DISPOSABLE_MARKERS = [
  "mailinator",
  "guerrillamail",
  "tempmail",
  "temp-mail",
  "10minutemail",
  "throwaway",
  "trashmail",
  "yopmail",
  "getnada",
];

function classifyEmailDomain(value: string): Record<string, unknown> {
  const raw = value.trim().toLowerCase();
  // Accept both a bare domain ("gmail.com") and a full address
  // ("carol@gmail.com") — the agent may pass either for kind email_domain.
  const d = raw.includes("@") ? (raw.split("@").pop() ?? raw) : raw;
  const isDisposable = DISPOSABLE_MARKERS.some((m) => d.includes(m));
  const isFreeWebmail = FREE_WEBMAIL_DOMAINS.has(d);
  return {
    category: isDisposable
      ? "disposable_high_risk"
      : isFreeWebmail
        ? "common_consumer_webmail"
        : "other_or_unrated",
    note:
      "Static/mock classification against a small local table — not a live threat-intel API. A category, not a verdict.",
  };
}

function classifyGeo(value: string): Record<string, unknown> {
  const v = value.trim();
  // README: "addr2 is the country code; 87 is the home country."
  const isHomeCountry = v === "87";
  return {
    home_country: isHomeCountry,
    note:
      "README defines addr2 code 87 as the dataset's home country; other billing-region/country codes are anonymized by the dataset publisher and otherwise unclassified here — mock enrichment, no real geo-IP service.",
  };
}

function classifyIp(value: string): Record<string, unknown> {
  return {
    input_echo: value,
    note:
      "The dataset (per README) has no literal IP address column — the id_* identity fields are encoded ratings and categorical flags (e.g. id_23 proxy category), not IPs. This 'ip' lookup kind is implemented as a placeholder mock for contract completeness; there is nothing dataset-specific to classify.",
  };
}

export const lookupExternal: LookupExternal = async (kind, value) => {
  let enrichment: Record<string, unknown>;
  switch (kind) {
    case "email_domain":
      enrichment = classifyEmailDomain(value);
      break;
    case "geo":
      enrichment = classifyGeo(value);
      break;
    case "ip":
      enrichment = classifyIp(value);
      break;
    default: {
      // Exhaustiveness guard — contracts/src/tools.ts's LookupExternal kind
      // union is the source of truth; if it grows, this must be updated.
      const _exhaustive: never = kind;
      throw new Error(`lookup_external: unknown kind ${String(_exhaustive)}`);
    }
  }
  return envelope("lookup_external", NO_AS_OF, "local", { kind, value, enrichment });
};
