// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import type { EvidenceBundle } from "./bundle.ts";

export type ComparisonOutcome = "reproduced" | "diverged" | "stale";

export interface Comparison {
  readonly outcome: ComparisonOutcome;
  readonly reference_id: string;
  readonly candidate_id: string;
  readonly differences: readonly string[];
}

// "stale" means the two bundles were not produced on the same tree or recipe,
// so their results are not comparable; it is reported, never silently upgraded
// to a reproduction.
export interface CompareOptions {
  // Evidence-only commit protocol: the candidate HEAD is the reference HEAD
  // plus a commit that only adds evidence files, so the trees under test are
  // identical and the HEAD difference is expected, not a staleness signal.
  readonly headMayDiffer?: boolean | undefined;
}

export function compareBundles(
  reference: EvidenceBundle,
  candidate: EvidenceBundle,
  options: CompareOptions = {},
): Comparison {
  const differences: string[] = [];
  if (
    options.headMayDiffer !== true &&
    reference.revision.head !== candidate.revision.head
  )
    differences.push("HEAD differs");
  if (reference.revision.diff_sha256 !== candidate.revision.diff_sha256)
    differences.push("working tree diff differs");
  if (reference.revision.status_sha256 !== candidate.revision.status_sha256)
    differences.push("working tree status differs");
  if (reference.recipe.hash !== candidate.recipe.hash)
    differences.push("recipe differs");
  if (differences.length > 0) {
    return {
      outcome: "stale",
      reference_id: reference.id,
      candidate_id: candidate.id,
      differences,
    };
  }
  const referenceById = new Map(reference.results.map((r) => [r.id, r]));
  for (const result of candidate.results) {
    const before = referenceById.get(result.id);
    if (before === undefined) {
      differences.push(`${result.id}: not in reference`);
      continue;
    }
    if (
      before.status !== result.status ||
      before.exit_code !== result.exit_code
    ) {
      differences.push(
        `${result.id}: ${before.status}${before.exit_code === null ? "" : ` (exit ${before.exit_code})`} → ${result.status}${result.exit_code === null ? "" : ` (exit ${result.exit_code})`}`,
      );
    }
  }
  for (const before of reference.results) {
    if (!candidate.results.some((r) => r.id === before.id))
      differences.push(`${before.id}: not re-run`);
  }
  if (reference.verdict !== candidate.verdict)
    differences.push(`verdict ${reference.verdict} → ${candidate.verdict}`);
  return {
    outcome: differences.length === 0 ? "reproduced" : "diverged",
    reference_id: reference.id,
    candidate_id: candidate.id,
    differences,
  };
}
