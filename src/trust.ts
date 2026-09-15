// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fail, ok, type Result } from "./result.ts";

export const RECIPE_LOCK_FILE = "recipe.lock.json";

export interface RecipeLock {
  readonly schema_version: 1;
  readonly recipe_sha256: string;
  readonly accepted_at: string;
  readonly accepted_by: string;
}

export type PinState =
  | { readonly state: "pinned" }
  | { readonly state: "unpinned" }
  | { readonly state: "changed"; readonly previous: RecipeLock };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function lockFile(outputDir: string): string {
  return join(outputDir, RECIPE_LOCK_FILE);
}

export async function readRecipeLock(
  outputDir: string,
): Promise<Result<RecipeLock | null>> {
  let text: string;
  try {
    text = await readFile(lockFile(outputDir), "utf8");
  } catch {
    return ok(null);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail(`${RECIPE_LOCK_FILE}: invalid JSON`);
  }
  if (
    !isRecord(raw) ||
    raw.schema_version !== 1 ||
    typeof raw.recipe_sha256 !== "string" ||
    typeof raw.accepted_at !== "string" ||
    typeof raw.accepted_by !== "string"
  ) {
    return fail(`${RECIPE_LOCK_FILE}: malformed`);
  }
  return ok({
    schema_version: 1,
    recipe_sha256: raw.recipe_sha256,
    accepted_at: raw.accepted_at,
    accepted_by: raw.accepted_by,
  });
}

// A recipe is code the repository asks the agent to execute. Running it the
// first time, or after it changed, is a decision a person takes once and the
// lock remembers; a cloned repository cannot smuggle a new command in silently.
export async function checkRecipePin(
  outputDir: string,
  recipeHash: string,
): Promise<Result<PinState>> {
  const lock = await readRecipeLock(outputDir);
  if (!lock.ok) return lock;
  if (lock.value === null) return ok({ state: "unpinned" });
  if (lock.value.recipe_sha256 === recipeHash) return ok({ state: "pinned" });
  return ok({ state: "changed", previous: lock.value });
}

export async function acceptRecipe(
  outputDir: string,
  recipeHash: string,
  acceptedBy: string,
  now: Date,
): Promise<RecipeLock> {
  const lock: RecipeLock = {
    schema_version: 1,
    recipe_sha256: recipeHash,
    accepted_at: now.toISOString(),
    accepted_by: acceptedBy,
  };
  await mkdir(outputDir, { recursive: true });
  const target = lockFile(outputDir);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return lock;
}

export function describePin(state: PinState, recipeHash: string): string {
  switch (state.state) {
    case "pinned":
      return `recette épinglée (${recipeHash.slice(0, 12)})`;
    case "unpinned":
      return `recette jamais acceptée (${recipeHash.slice(0, 12)}) : exécuter la recette exécute le code déclaré par ce dépôt`;
    case "changed":
      return `recette modifiée : ${state.previous.recipe_sha256.slice(0, 12)} (acceptée le ${state.previous.accepted_at} par ${state.previous.accepted_by}) → ${recipeHash.slice(0, 12)}`;
  }
}
