// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type CheckSpec, DEFAULT_TIMEOUT_SECONDS } from "./config.ts";

// In this fleet a `check` script composes lint, typecheck and tests: when it
// exists it is the only script discovered, otherwise every check would run
// twice and the bundle would report the same failure under two ids.
export const COMPOSITE_SCRIPT = "check" as const;
export const DISCOVERED_SCRIPTS = ["lint", "typecheck", "test"] as const;

// Discovered checks are never `required`: nobody declared them as criteria,
// so they can only support an "unverified / no problem detected" verdict.
export async function discoverChecks(repoRoot: string): Promise<CheckSpec[]> {
  const checks: CheckSpec[] = [];
  const packageFile = join(repoRoot, "package.json");
  if (existsSync(packageFile)) {
    let scripts: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(await readFile(packageFile, "utf8"));
      if (typeof parsed === "object" && parsed !== null) {
        const candidate = (parsed as { scripts?: unknown }).scripts;
        if (typeof candidate === "object" && candidate !== null) {
          scripts = candidate as Record<string, unknown>;
        }
      }
    } catch {
      scripts = {};
    }
    const runner = existsSync(join(repoRoot, "bun.lock")) ? "bun" : "npm";
    const names: readonly string[] =
      typeof scripts[COMPOSITE_SCRIPT] === "string"
        ? [COMPOSITE_SCRIPT]
        : DISCOVERED_SCRIPTS;
    for (const name of names) {
      if (typeof scripts[name] !== "string") continue;
      checks.push({
        id: name,
        command: runner,
        args: ["run", name],
        required: false,
        timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
      });
    }
  }
  if (existsSync(join(repoRoot, "Cargo.toml"))) {
    checks.push({
      id: "cargo-test",
      command: "cargo",
      args: ["test"],
      required: false,
      timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
    });
  }
  return checks;
}
