import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { PolicyConfigSchema, type PolicyConfig } from "@hhgoa/contracts";

const defaultPolicyPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "policy.yaml",
);

/**
 * Loads and validates `policy/policy.yaml` against
 * `contracts/src/policy.ts`'s `PolicyConfigSchema`. Throws on any shape
 * violation — a malformed policy file must fail loudly at startup, not
 * silently deny/allow the wrong things at runtime.
 */
export function loadPolicyConfig(filePath: string = defaultPolicyPath): PolicyConfig {
  const raw = readFileSync(filePath, "utf-8");
  const parsed: unknown = parseYaml(raw);
  return PolicyConfigSchema.parse(parsed);
}

/** Singleton default policy, loaded once and reused by engine.ts. */
let cached: PolicyConfig | undefined;
export function getPolicyConfig(): PolicyConfig {
  cached ??= loadPolicyConfig();
  return cached;
}

/** Test-only: force a reload (e.g. after pointing at a fixture policy.yaml). */
export function resetPolicyConfigCache(): void {
  cached = undefined;
}
