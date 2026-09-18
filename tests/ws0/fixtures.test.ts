import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { AgentEventSchema } from "../../contracts/src/agentEvent.js";
import { AnswerFileSchema } from "../../contracts/src/answerFile.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
);

const fixtureFiles = readdirSync(fixturesDir).filter((f) => f.endsWith(".json"));

describe("fixtures/", () => {
  it("has at least 2 recorded case runs", () => {
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(2);
  });

  for (const file of fixtureFiles) {
    describe(file, () => {
      const run = JSON.parse(readFileSync(path.join(fixturesDir, file), "utf-8"));

      it("every event validates against AgentEventSchema", () => {
        for (const event of run.events) {
          const result = AgentEventSchema.safeParse(event);
          expect(result.success, JSON.stringify(result.success ? null : result.error?.issues)).toBe(true);
        }
      });

      it("seq is strictly increasing and case_id is consistent", () => {
        let lastSeq = -1;
        for (const event of run.events) {
          expect(event.seq).toBeGreaterThan(lastSeq);
          lastSeq = event.seq;
          expect(event.case_id).toBe(run.case_id);
        }
      });

      it("the embedded answer validates against AnswerFileSchema", () => {
        const result = AnswerFileSchema.safeParse(run.answer);
        expect(result.success, JSON.stringify(result.success ? null : result.error.issues)).toBe(true);
      });

      it("the embedded answer's case_id matches the run's case_id", () => {
        expect(run.answer.case_id).toBe(run.case_id);
      });
    });
  }
});
