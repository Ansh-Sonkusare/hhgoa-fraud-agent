import { loadClosedCases } from "./dataset.js";
import { runBacktestSample } from "./backtest.js";
import { computeMetrics, renderMetricsTable } from "./metrics.js";
import { loadEnv } from "./env.js";

async function main(): Promise<number> {
  loadEnv();
  const ids = process.argv.slice(2).filter((a) => a.startsWith("CC-"));
  if (ids.length === 0) {
    process.stderr.write("usage: rerunCases.ts CC-0001 CC-0002 ...\n");
    return 1;
  }
  const all = loadClosedCases();
  const byId = new Map(all.map((c) => [c.case_id, c]));
  const sample = ids.map((id) => byId.get(id)).filter((c): c is NonNullable<typeof c> => Boolean(c));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) process.stderr.write(`not found: ${missing.join(", ")}\n`);
  process.stdout.write(`re-running ${sample.length} case(s)\n`);
  const { runs } = await runBacktestSample(sample, { noCache: true });
  process.stdout.write(`\n${renderMetricsTable(computeMetrics(runs, 0))}\n`);
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { process.stderr.write(`${e}\n`); process.exit(1); });
