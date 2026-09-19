import path from "node:path";
import { loadIdIndex, loadCasePack, indexStats } from "./dataset.js";
import { runValidation } from "./validateAnswers.js";
import { loadEnv, repoRoot } from "./env.js";

async function main(): Promise<number> {
  loadEnv();
  const casesDir = path.join(repoRoot(), "cases");
  const index = await loadIdIndex();

  const stats = indexStats(index);
  process.stdout.write(`datasets indexed: ${JSON.stringify(stats)}\n`);

  const idSet = new Set(loadCasePack().map((c) => c.case_id));
  const { summary, printed } = runValidation(casesDir, index, { expectCaseIds: idSet });
  process.stdout.write(printed + "\n");
  return summary.ok ? 0 : 1;
}

if (process.argv[1]?.endsWith("validate.ts")) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`validate-answers failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}