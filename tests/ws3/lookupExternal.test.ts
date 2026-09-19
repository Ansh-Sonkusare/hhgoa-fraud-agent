import { describe, expect, it } from "vitest";
import { lookupExternal } from "../../rag/src/externalLookup.js";
import { AnyToolResultSchema } from "../../contracts/src/toolEnvelope.js";

describe("lookup_external", () => {
  it("flags disposable email domains as high risk", async () => {
    const r = await lookupExternal("email_domain", "foo@mailinator.com");
    expect(r.ok).toBe(true);
    expect(r.data.enrichment.category).toBe("disposable_high_risk");
    expect(r.data.enrichment.note).toContain("Static/mock");
  });

  it("recognises common consumer webmail as low-signal, not high-risk", async () => {
    const r = await lookupExternal("email_domain", "CAROL@GMAIL.COM");
    expect(r.data.enrichment.category).toBe("common_consumer_webmail");
  });

  it("leaves custom domains unrated", async () => {
    const r = await lookupExternal("email_domain", "carol@somecorp.example");
    expect(r.data.enrichment.category).toBe("other_or_unrated");
  });

  it("classifies the home-country address code 87", async () => {
    const home = await lookupExternal("geo", "87");
    expect(home.data.enrichment.home_country).toBe(true);
    const away = await lookupExternal("geo", "61");
    expect(away.data.enrichment.home_country).toBe(false);
  });

  it("echoes the input for the placeholder 'ip' kind", async () => {
    const r = await lookupExternal("ip", "203.0.113.7");
    expect(r.data.enrichment.input_echo).toBe("203.0.113.7");
  });

  it("emits a contract-schema-valid envelope labelled external/local", async () => {
    const r = await lookupExternal("email_domain", "a@b.example");
    expect(AnyToolResultSchema.safeParse(r).success).toBe(true);
    expect(r.tool).toBe("lookup_external");
    expect(r.via).toBe("local");
    expect(r.as_of).toBe("n/a");
    expect(r.truncated).toBe(false);
  });
});