/**
 * Regulatory reference text (README's "Regulatory references" section) for
 * the vector store. Best-effort by design — the README says "load the
 * ones you find useful" (optional depth), and this sandbox's network
 * environment blocks most of the listed sources outright:
 *
 * - FFIEC BSA/AML manual pages (bsaaml.ffiec.gov): 403 on every fetch
 *   attempt (bot-protected), both via direct `curl` and via the WebFetch
 *   tool.
 * - FATF (fatf-gafi.org): 403, same story.
 * - Most FinCEN documents (fincen.gov/system/files/.../*.pdf): fetchable
 *   as bytes but not extractable — this environment has no `pdftotext`/
 *   `poppler-utils` and no package manager access (`apt-get` unavailable,
 *   no sudo) to install one, so the PDF binary comes back but can't be
 *   turned into text. See `docs/REQUESTS.md` for the ask (either the repo
 *   gains `poppler-utils`/a JS PDF-text library, or someone with a working
 *   network path pastes the extracted text).
 *
 * One source *did* work: FinCEN publishes some advisories as plain HTML
 * (not PDF), and `fincen.gov/resources/advisories/...` pages fetch fine.
 * The Account Takeover advisory below is real, current content from that
 * URL (WebFetch, 2026-09-18) — condensed by the fetch tool's summarizer,
 * not a byte-for-byte copy, which is why `source_kind` distinguishes
 * `"regulatory"` from `"policy"`/`"pattern"` (bank-authored, byte-exact
 * from README.md) in `PolicyChunkRecord`.
 */
export interface RegulatoryDoc {
  source_doc: string;
  url: string;
  markdown: string;
}

export const REGULATORY_DOCS: RegulatoryDoc[] = [
  {
    source_doc: "FinCEN Advisory FIN-2011-A016: Account Takeover Activity",
    url: "https://www.fincen.gov/resources/advisories/fincen-advisory-fin-2011-a016",
    markdown: `## FinCEN Advisory FIN-2011-A016: Account Takeover Activity

Issued December 19, 2011. The Financial Crimes Enforcement Network issued
this advisory to help financial institutions identify account takeover
activity and file Suspicious Activity Reports (SARs).

### Identifying Account Takeover Activity

Cybercriminals employ sophisticated methods to gain account access,
including malware, SQL injection attacks, spyware, Trojans, and worms.

Financial institutions may detect account takeover through monitoring
irregularities including: unusual ATM activity; clustered ACH transactions
in different geographic areas; sudden wire transfers; changes to customer
and account profiles.

Account takeover differs from computer intrusion in that the customer,
rather than the financial institution maintaining the account, is the
primary target.

### Suspicious Activity Reporting Requirements

Financial institutions must file SARs when they know, suspect, or have
reason to suspect that a transaction conducted or attempted by, at, or
through the financial institution involves funds derived from illegal
activity.

When reporting suspected account takeover, institutions should use
"account takeover fraud" in SAR narratives and consider these boxes:
computer intrusion cases should check "computer intrusion" and "other"
noting "account takeover fraud"; telephone/social-engineering cases should
check "other" with a description; wire-transfer cases should check "wire
transfer fraud" plus "other"; ACH-transfer cases should note "account
takeover fraud - ACH"; identity-theft elements should check "identity
theft" if unauthorized PINs/account numbers were involved.`,
  },
];
