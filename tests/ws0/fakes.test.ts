import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakes } from "../../contracts/src/fakes.js";

const examplesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "contracts",
  "examples",
);

function loadExample(name: string): unknown {
  return JSON.parse(readFileSync(path.join(examplesDir, `${name}.json`), "utf-8"));
}

const AS_OF = "2016-11-12T00:00:00Z";
const entity = { type: "Card", id: "C09001-K1" };

interface Case {
  name: keyof typeof fakes;
  call: () => Promise<{ ok: boolean; as_of: string; data: unknown }>;
  expectAsOf: boolean;
}

const cases: Case[] = [
  {
    name: "resolve_trigger",
    call: () => fakes.resolve_trigger({ kind: "risk_score", txn_id: "9900004", risk_score: 0.5 }, AS_OF),
    expectAsOf: true,
  },
  { name: "get_entity_profile", call: () => fakes.get_entity_profile(entity, AS_OF), expectAsOf: true },
  {
    name: "get_transaction_history",
    call: () => fakes.get_transaction_history(entity, { hours: 2 }, AS_OF),
    expectAsOf: true,
  },
  { name: "get_neighborhood", call: () => fakes.get_neighborhood(entity, 2, {}, AS_OF), expectAsOf: true },
  { name: "compute_velocity", call: () => fakes.compute_velocity(entity, 60, AS_OF), expectAsOf: true },
  {
    name: "find_shared_entity_rings",
    call: () => fakes.find_shared_entity_rings(entity, AS_OF),
    expectAsOf: true,
  },
  { name: "get_baseline_deviation", call: () => fakes.get_baseline_deviation(entity, AS_OF), expectAsOf: true },
  { name: "detect_patterns", call: () => fakes.detect_patterns(entity, AS_OF), expectAsOf: true },
  { name: "get_community", call: () => fakes.get_community(entity, AS_OF), expectAsOf: true },
  { name: "find_prior_cases", call: () => fakes.find_prior_cases(entity, AS_OF), expectAsOf: true },
  { name: "get_wide_features", call: () => fakes.get_wide_features(["9900004"]), expectAsOf: false },
  { name: "retrieve_policy", call: () => fakes.retrieve_policy("card testing", undefined, 3), expectAsOf: false },
  {
    name: "retrieve_similar_cases",
    call: () => fakes.retrieve_similar_cases({}, AS_OF, 3),
    expectAsOf: true,
  },
  { name: "lookup_external", call: () => fakes.lookup_external("email_domain", "gmail.com"), expectAsOf: false },
  {
    name: "case_open",
    call: () => fakes.case_open({ kind: "risk_score", risk_score: 0.5 }, AS_OF),
    expectAsOf: true,
  },
  {
    name: "case_add_evidence",
    call: () =>
      fakes.case_add_evidence(
        "HHG-901",
        {
          id: "ev_1",
          category: "graph_structure",
          summary: "x",
          entities: [],
          source_tool: "x",
          weight_hint: 0.1,
          supports: [],
          contradicts: [],
          ts: AS_OF,
        },
        AS_OF,
      ),
    expectAsOf: true,
  },
  {
    name: "case_add_finding",
    call: () => fakes.case_add_finding("HHG-901", { id: "f1", category: "x", text: "x", score: 0.5 }, AS_OF),
    expectAsOf: true,
  },
  {
    name: "case_update_assessment",
    call: () =>
      fakes.case_update_assessment(
        "HHG-901",
        {
          hypotheses: [],
          risk_level: "LOW",
          risk_score: 0.1,
          confidence: 0.2,
          sufficiency: { sufficient: false, missing: [], stop_reason: null },
          legit_hypothesis_probability: 0.8,
        },
        AS_OF,
      ),
    expectAsOf: true,
  },
  {
    name: "case_record_decision",
    call: () => fakes.case_record_decision("HHG-901", { id: "d1", text: "x", actor: "agent" }, AS_OF),
    expectAsOf: true,
  },
  {
    name: "case_record_action",
    call: () =>
      fakes.case_record_action(
        "HHG-901",
        { action: "BLOCK_CARD", route: "L1", reason: "x" },
        "PENDING_APPROVAL",
        AS_OF,
      ),
    expectAsOf: true,
  },
  { name: "case_set_status", call: () => fakes.case_set_status("HHG-901", "open", AS_OF), expectAsOf: true },
  { name: "case_close", call: () => fakes.case_close("HHG-901", AS_OF), expectAsOf: true },
  {
    name: "policy_check",
    call: () => fakes.policy_check({ action_or_request: "BLOCK_CARD", case_state: {} }),
    expectAsOf: false,
  },
  {
    name: "execute_action",
    call: () => fakes.execute_action({ action: "BLOCK_CARD", params: {} }),
    expectAsOf: false,
  },
  {
    name: "request_evidence",
    call: () =>
      fakes.request_evidence({
        type: "customer_validation",
        target: { type: "Customer", id: "C09001" },
        reason: "x",
      }),
    expectAsOf: false,
  },
  { name: "generate_sar", call: () => fakes.generate_sar("HHG-901"), expectAsOf: false },
];

describe("fakes", () => {
  it("covers exactly the 26 ToolCatalog tools", () => {
    expect(cases.map((c) => c.name).sort()).toEqual(Object.keys(fakes).sort());
  });

  for (const c of cases) {
    describe(c.name, () => {
      it("returns ok:true with data matching its example fixture", async () => {
        const result = await c.call();
        expect(result.ok).toBe(true);
        expect(result.data).toEqual(loadExample(c.name));
      });

      if (c.expectAsOf) {
        it("echoes back the as_of argument", async () => {
          const result = await c.call();
          expect(result.as_of).toBe(AS_OF);
        });
      }
    });
  }
});
