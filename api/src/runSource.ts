import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { AgentEventSchema, AnswerFileSchema, type AgentEvent, type AnswerFile } from "@hhgoa/contracts";
import { FIXTURES_DIR } from "./env.js";

/** A complete recorded (or, later, live) agent run for one case. */
export interface RunRecording {
  case_id: string;
  events: AgentEvent[];
  answer: AnswerFile;
}

/**
 * Source of investigation runs. `FixtureRunSource` below is the only
 * implementation today, replaying `fixtures/*.json`. WS4's real agent isn't
 * merged yet (PRD §16 WS6 depends only on WS0's fixtures/AgentEvent).
 *
 * The seam for plugging in a live agent later: implement this same
 * interface backed by `agent/machine.ts` (e.g. run the state machine,
 * collect/forward each `AgentEvent` as it's emitted instead of reading a
 * static array, and resolve `answer` once the run reaches DONE). Nothing
 * in `routes/` or `replaySession.ts` needs to change — they only depend on
 * `RunSource`, never on "fixture" specifically. Swap the instance
 * constructed in `server.ts` (gated by `TOOLS_BACKEND`/an equivalent
 * `RUN_SOURCE` env var) and everything downstream keeps working.
 */
export interface RunSource {
  /** Case ids this source has (or can produce) a full recorded run for. */
  listKnownCaseIds(): string[];
  /** `null` if this source has nothing for this case id. */
  getRecording(caseId: string): RunRecording | null;
}

function loadFixtureFile(filePath: string): RunRecording {
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`fixture ${filePath} is not a JSON object`);
  }
  const obj = raw as { case_id?: unknown; events?: unknown; answer?: unknown };
  const events = (Array.isArray(obj.events) ? obj.events : []).map((e) =>
    AgentEventSchema.parse(e),
  );
  const answer = AnswerFileSchema.parse(obj.answer);
  if (typeof obj.case_id !== "string") {
    throw new Error(`fixture ${filePath} missing case_id`);
  }
  return { case_id: obj.case_id, events, answer };
}

export class FixtureRunSource implements RunSource {
  private readonly recordings = new Map<string, RunRecording>();

  constructor(fixturesDir: string = FIXTURES_DIR) {
    const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const recording = loadFixtureFile(path.join(fixturesDir, file));
      this.recordings.set(recording.case_id, recording);
    }
  }

  listKnownCaseIds(): string[] {
    return [...this.recordings.keys()];
  }

  getRecording(caseId: string): RunRecording | null {
    return this.recordings.get(caseId) ?? null;
  }
}
