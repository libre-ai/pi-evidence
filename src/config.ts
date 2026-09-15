// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fail, ok, type Result } from "./result.ts";

export const CONFIG_FILE = ".evidence.json";
export const DEFAULT_OUTPUT_DIR = ".evidence";
export const DEFAULT_TIMEOUT_SECONDS = 600;

// What the extension does at the end of a turn that changed the tree without
// producing evidence: nothing, a visible reminder, or a follow-up demand.
export type GuardPolicy = "off" | "remind" | "require";
export const GUARD_POLICIES: readonly GuardPolicy[] = [
  "off",
  "remind",
  "require",
];

export interface CheckSpec {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly required: boolean;
  readonly timeout_seconds: number;
}

export interface EvidenceConfig {
  readonly schema_version: 1;
  readonly checks: readonly CheckSpec[];
  readonly output_dir: string;
  readonly policy: GuardPolicy;
}

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// A command is a bare executable name resolved on PATH: no shell, no path
// traversal, no embedded arguments.
const COMMAND = /^[A-Za-z0-9._+-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCheck(value: unknown, index: number): Result<CheckSpec> {
  if (!isRecord(value)) return fail(`checks[${index}]: expected an object`);
  if (typeof value.id !== "string" || !ID.test(value.id)) {
    return fail(`checks[${index}]: id must match ${ID.source}`);
  }
  if (typeof value.command !== "string" || !COMMAND.test(value.command)) {
    return fail(
      `checks[${index}] (${value.id}): command must be a bare executable name (no path, no spaces)`,
    );
  }
  const args = value.args ?? [];
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
    return fail(
      `checks[${index}] (${value.id}): args must be an array of strings`,
    );
  }
  if (value.required !== undefined && typeof value.required !== "boolean") {
    return fail(`checks[${index}] (${value.id}): required must be a boolean`);
  }
  const timeout = value.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
  if (
    typeof timeout !== "number" ||
    !Number.isInteger(timeout) ||
    timeout <= 0
  ) {
    return fail(
      `checks[${index}] (${value.id}): timeout_seconds must be a positive integer`,
    );
  }
  return ok({
    id: value.id,
    command: value.command,
    args: args as string[],
    required: value.required ?? false,
    timeout_seconds: timeout,
  });
}

export function parseConfig(value: unknown): Result<EvidenceConfig> {
  if (!isRecord(value) || value.schema_version !== 1) {
    return fail(`${CONFIG_FILE}: expected schema_version 1`);
  }
  if (!Array.isArray(value.checks) || value.checks.length === 0) {
    return fail(`${CONFIG_FILE}: checks must be a non-empty array`);
  }
  const checks: CheckSpec[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of value.checks.entries()) {
    const parsed = parseCheck(raw, index);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.value.id))
      return fail(`${CONFIG_FILE}: duplicate check id ${parsed.value.id}`);
    seen.add(parsed.value.id);
    checks.push(parsed.value);
  }
  const outputDir = value.output_dir ?? DEFAULT_OUTPUT_DIR;
  if (
    typeof outputDir !== "string" ||
    outputDir === "" ||
    outputDir.startsWith("/") ||
    outputDir.includes("..")
  ) {
    return fail(
      `${CONFIG_FILE}: output_dir must be a relative path inside the repository`,
    );
  }
  const policy = value.policy ?? "remind";
  if (
    typeof policy !== "string" ||
    !(GUARD_POLICIES as readonly string[]).includes(policy)
  ) {
    return fail(
      `${CONFIG_FILE}: policy must be one of ${GUARD_POLICIES.join(", ")}`,
    );
  }
  return ok({
    schema_version: 1,
    checks,
    output_dir: outputDir,
    policy: policy as GuardPolicy,
  });
}

export type ConfigLookup =
  | { readonly kind: "declared"; readonly config: EvidenceConfig }
  | { readonly kind: "absent" };

export async function loadConfig(
  repoRoot: string,
): Promise<Result<ConfigLookup>> {
  let text: string;
  try {
    text = await readFile(join(repoRoot, CONFIG_FILE), "utf8");
  } catch {
    return ok({ kind: "absent" });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail(`${CONFIG_FILE}: invalid JSON`);
  }
  const parsed = parseConfig(raw);
  if (!parsed.ok) return parsed;
  return ok({ kind: "declared", config: parsed.value });
}
