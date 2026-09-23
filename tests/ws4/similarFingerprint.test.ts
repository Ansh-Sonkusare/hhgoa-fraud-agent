import { describe, expect, it } from "vitest";
import { createFacts, createGatherRuntime, runStandardGather } from "../../agent/src/investigation.js";
import type { ToolCatalog } from "../../contracts/src/index.js";

const AS_OF = "2016-07-22 19:52:55";

function fakeCatalog(handlers: Partial<Record<keyof ToolCatalog, (...a: unknown[]) => unknown>>): ToolCatalog {
  return new Proxy({} as ToolCatalog, {
    get: (_t, name: string) => async (...args: unknown[]) => {
      const h = handlers[name as keyof ToolCatalog];
      return h ? { ok: true, data: h(...args) } : { ok: false, error: { code: "unavailable", message: name } };
    },
  });
}

describe("similar-case fingerprint (CC-0955)", () => {
  it("links through specific rings only, not fingerprint crowds or email domains", async () => {
    const crowd = Array.from({ length: 30 }, (_, i) => `C9${String(i).padStart(4, "0")}-K1`);
    let fingerprint: { entity_ids: Array<{ type: string; id: string }> } | null = null;
    const catalog = fakeCatalog({
      resolve_trigger: () => ({
        txn: { type: "Transaction", id: "3084012" },
        card: { type: "Card", id: "C10849-K1" },
        customer: { type: "Customer", id: "C10849" },
        identity: null,
      }),
      find_shared_entity_rings: () => ({
        rings: [
          { shared_type: "device", shared_id: "d-specific", card_ids: ["C10849-K1", "C03539-K1", "C01111-K2"] },
          { shared_type: "device", shared_id: "d-crowd", card_ids: ["C10849-K1", ...crowd] },
          { shared_type: "email", shared_id: "gmail.com", card_ids: ["C10849-K1", "C07777-K1"] },
        ],
      }),
      retrieve_similar_cases: (fp) => {
        fingerprint = fp as typeof fingerprint;
        return { cases: [] };
      },
    });
    const facts = createFacts("CC-0955", AS_OF, { kind: "risk_score", txn_id: "3084012", risk_score: 0.86 });
    await runStandardGather(createGatherRuntime({ catalog, facts, asOf: AS_OF }));
    const cards = fingerprint!.entity_ids.filter((e) => e.type === "Card").map((e) => e.id);
    expect(cards).toEqual(["C10849-K1", "C03539-K1", "C01111-K2"]);
  });
});
