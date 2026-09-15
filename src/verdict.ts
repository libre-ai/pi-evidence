// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import type { RecipeOrigin } from "./recipe.ts";
import type { CheckResult } from "./runner.ts";

export type Verdict = "conformant" | "failed" | "incomplete" | "unverified";

export interface VerdictExplanation {
  readonly verdict: Verdict;
  readonly reasons: readonly string[];
  readonly criteria_declared: boolean;
}

// Precedence: any failure wins; then an interrupted run or a required check
// that did not run; then conformance only if criteria were declared;
// otherwise the honest "no problem detected".
export function computeVerdict(
  results: readonly CheckResult[],
  origin: RecipeOrigin,
  allChecksSelected: boolean,
): VerdictExplanation {
  const reasons: string[] = [];
  const failed = results.filter(
    (r) => r.status === "failed" || r.status === "timeout",
  );
  for (const r of failed) {
    reasons.push(
      `${r.id}: ${r.status}${r.exit_code === null ? "" : ` (exit ${r.exit_code})`}`,
    );
  }
  const interrupted = results.filter(
    (r) => r.status === "aborted" || r.status === "skipped",
  );
  for (const r of interrupted) reasons.push(`${r.id}: ${r.status} (run interrupted)`);
  const requiredUnavailable = results.filter(
    (r) => r.required && r.status === "unavailable",
  );
  for (const r of requiredUnavailable) reasons.push(`${r.id}: required check unavailable`);
  const optionalUnavailable = results.filter(
    (r) => !r.required && r.status === "unavailable",
  );
  for (const r of optionalUnavailable) reasons.push(`${r.id}: optional check unavailable`);
  const criteriaDeclared =
    origin === "declared" && results.some((r) => r.required);
  if (failed.length > 0) {
    return { verdict: "failed", reasons, criteria_declared: criteriaDeclared };
  }
  if (interrupted.length > 0 || requiredUnavailable.length > 0) {
    return { verdict: "incomplete", reasons, criteria_declared: criteriaDeclared };
  }
  if (!allChecksSelected && origin === "declared") {
    reasons.push("subset of the recipe executed: required checks may be missing");
    return { verdict: "incomplete", reasons, criteria_declared: criteriaDeclared };
  }
  if (criteriaDeclared) {
    reasons.push("all required checks passed");
    return { verdict: "conformant", reasons, criteria_declared: true };
  }
  reasons.push(
    origin === "declared"
      ? "recipe declares no required check"
      : "no declared criteria: discovered checks only",
  );
  reasons.push("no problem detected; this is not a conformance");
  return { verdict: "unverified", reasons, criteria_declared: false };
}
