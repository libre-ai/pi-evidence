// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { type CheckSpec, DEFAULT_OUTPUT_DIR, loadConfig } from "./config.ts";
import { discoverChecks } from "./discovery.ts";
import { fail, ok, type Result } from "./result.ts";

export type RecipeOrigin = "declared" | "discovered";

export interface Recipe {
  readonly origin: RecipeOrigin;
  readonly checks: readonly CheckSpec[];
  readonly output_dir: string;
  readonly hash: string;
}

// Canonical JSON of the fields that change what gets executed: a bundle can
// then say "this exact recipe" rather than "some checks".
export function recipeHash(checks: readonly CheckSpec[]): string {
  const canonical = checks.map((check) => ({
    id: check.id,
    command: check.command,
    args: [...check.args],
    required: check.required,
    timeout_seconds: check.timeout_seconds,
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export async function resolveRecipe(repoRoot: string): Promise<Result<Recipe>> {
  const lookup = await loadConfig(repoRoot);
  if (!lookup.ok) return lookup;
  if (lookup.value.kind === "declared") {
    const { checks, output_dir } = lookup.value.config;
    return ok({
      origin: "declared",
      checks,
      output_dir,
      hash: recipeHash(checks),
    });
  }
  const checks = await discoverChecks(repoRoot);
  if (checks.length === 0) {
    return fail(
      "no recipe: no .evidence.json and no discoverable scripts (package.json lint/typecheck/test/check, Cargo.toml)",
    );
  }
  return ok({
    origin: "discovered",
    checks,
    output_dir: DEFAULT_OUTPUT_DIR,
    hash: recipeHash(checks),
  });
}

export function selectChecks(
  recipe: Recipe,
  only: readonly string[],
): Result<readonly CheckSpec[]> {
  if (only.length === 0) return ok(recipe.checks);
  const unknown = only.filter(
    (id) => !recipe.checks.some((check) => check.id === id),
  );
  if (unknown.length > 0)
    return fail(`unknown check id(s): ${unknown.join(", ")}`);
  return ok(recipe.checks.filter((check) => only.includes(check.id)));
}
