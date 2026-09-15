// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_FILE } from "./config.ts";
import { discoverChecks } from "./discovery.ts";
import { fail, ok, type Result } from "./result.ts";

// `init` turns discovery into a declared recipe the team can edit; every check
// starts as not required so a fresh recipe can never claim conformance by
// accident: someone has to decide what the criteria are.
export async function initRecipe(
  repoRoot: string,
  options: { readonly force?: boolean | undefined } = {},
): Promise<Result<{ file: string; checks: readonly string[] }>> {
  const file = join(repoRoot, CONFIG_FILE);
  if (existsSync(file) && options.force !== true) {
    return fail(`${CONFIG_FILE} already exists (use --force to overwrite)`);
  }
  const checks = await discoverChecks(repoRoot);
  if (checks.length === 0) {
    return fail(
      "nothing discoverable: add checks by hand (package.json scripts or Cargo.toml)",
    );
  }
  const recipe = {
    schema_version: 1,
    notes:
      "Generated from discovery. Set required: true on the checks that define conformance; a recipe without required checks can only reach the unverified verdict.",
    checks: checks.map((check) => ({
      id: check.id,
      command: check.command,
      args: [...check.args],
      required: false,
      timeout_seconds: check.timeout_seconds,
    })),
  };
  await writeFile(file, `${JSON.stringify(recipe, null, 2)}\n`, "utf8");
  return ok({ file, checks: checks.map((c) => c.id) });
}
