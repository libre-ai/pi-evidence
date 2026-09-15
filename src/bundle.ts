// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import type { RevisionBinding, ToolVersions } from "./binding.ts";
import type { CheckSpec } from "./config.ts";
import type { Differential } from "./differential.ts";
import type { EnvironmentFingerprint } from "./environment.ts";
import type { RecipeOrigin } from "./recipe.ts";
import { fail, ok, type Result } from "./result.ts";
import type { CheckResult } from "./runner.ts";
import type { Verdict } from "./verdict.ts";

export interface SessionIdentity {
  readonly session_id: string;
  readonly provider: string;
  readonly model: string;
  readonly thinking_level: string | null;
}

export interface EvidenceBundle {
  readonly schema_version: 2;
  readonly id: string;
  readonly created_at: string;
  // Repository identity without any machine-local path: bundles are meant to
  // be committed and read on other machines.
  readonly repository: {
    readonly name: string;
    readonly origin: string | null;
  };
  readonly revision: RevisionBinding;
  readonly recipe: {
    readonly origin: RecipeOrigin;
    readonly hash: string;
    readonly checks: readonly CheckSpec[];
    readonly selected: readonly string[];
  };
  readonly results: readonly CheckResult[];
  readonly verdict: Verdict;
  readonly reasons: readonly string[];
  readonly criteria_declared: boolean;
  readonly requirement: string | null;
  readonly environment: EnvironmentFingerprint;
  readonly differential: Differential | null;
  readonly session: SessionIdentity;
  readonly tools: ToolVersions;
}

// Only run bundles are listed: sidecars (recipe lock, acceptance, attestation)
// share the directory but never count as evidence of a run.
export const BUNDLE_FILE = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}(?:-[0-9]+)?\.json$/;

export function bundleId(createdAt: Date, head: string): string {
  const stamp = createdAt
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${head.slice(0, 7)}`;
}

export function bundleFile(outputDir: string, id: string): string {
  return join(outputDir, `${id}.json`);
}

// Temporary file then rename: an interrupted write never leaves a truncated
// bundle that could be mistaken for evidence.
export async function writeBundle(
  outputDir: string,
  bundle: EvidenceBundle,
): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const target = bundleFile(outputDir, bundle.id);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return target;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const VERDICTS: readonly Verdict[] = [
  "conformant",
  "failed",
  "incomplete",
  "unverified",
];

// A structural guard, not a full schema: the JSON schema in docs/ is enforced
// by the test-suite; at runtime a malformed bundle is reported, not trusted.
export function parseBundle(value: unknown): Result<EvidenceBundle> {
  if (
    !isRecord(value) ||
    (value.schema_version !== 1 && value.schema_version !== 2)
  )
    return fail("bundle: expected schema_version 1 or 2");
  if (
    typeof value.id !== "string" ||
    typeof value.created_at !== "string" ||
    !isRecord(value.repository) ||
    typeof value.repository.name !== "string" ||
    !isRecord(value.revision) ||
    typeof value.revision.head !== "string" ||
    !isRecord(value.recipe) ||
    typeof value.recipe.hash !== "string" ||
    !Array.isArray(value.results) ||
    !VERDICTS.includes(value.verdict as Verdict) ||
    !Array.isArray(value.reasons) ||
    typeof value.criteria_declared !== "boolean" ||
    !isRecord(value.session) ||
    !isRecord(value.tools)
  ) {
    return fail("bundle: malformed record");
  }
  // A version-1 bundle predates environment, differential, requirement and
  // redaction fields: read it with explicit empty values so old evidence
  // stays listable, never silently treated as a version-2 record.
  if (value.schema_version === 1) {
    const results = (value.results as Record<string, unknown>[]).map((r) => ({
      ...r,
      redactions: Array.isArray(r.redactions) ? r.redactions : [],
    }));
    return ok({
      ...(value as unknown as EvidenceBundle),
      schema_version: 2,
      results: results as unknown as EvidenceBundle["results"],
      requirement:
        typeof value.requirement === "string" ? value.requirement : null,
      environment: {
        platform: "unknown",
        arch: "unknown",
        lockfiles: {},
        node_modules_present: false,
        fingerprint_sha256: "0".repeat(64),
      },
      differential: null,
    });
  }
  return ok(value as unknown as EvidenceBundle);
}

export async function loadBundle(
  file: string,
): Promise<Result<EvidenceBundle>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return fail(`bundle not found: ${basename(file)}`);
  }
  try {
    return parseBundle(JSON.parse(text));
  } catch {
    return fail(`bundle is not valid JSON: ${basename(file)}`);
  }
}

export async function listBundleIds(outputDir: string): Promise<string[]> {
  try {
    const entries = await readdir(outputDir);
    return entries
      .filter((name) => BUNDLE_FILE.test(name))
      .map((name) => name.slice(0, -5))
      .sort();
  } catch {
    return [];
  }
}
