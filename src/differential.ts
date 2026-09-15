// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { lstat, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckSpec } from "./config.ts";
import {
  type EnvironmentFingerprint,
  fingerprintEnvironment,
  sameDependencies,
} from "./environment.ts";
import type { ExecFn } from "./exec.ts";
import { fail, ok, type Result } from "./result.ts";
import { type CheckResult, type CheckStatus, runChecks } from "./runner.ts";

export type Classification =
  | "regression"
  | "pre-existing"
  | "fixed"
  | "stable"
  | "not-comparable";

export interface DifferentialEntry {
  readonly id: string;
  readonly base_status: CheckStatus | null;
  readonly candidate_status: CheckStatus;
  readonly classification: Classification;
}

export interface Differential {
  readonly base_ref: string;
  readonly base_head: string;
  readonly base_results: readonly CheckResult[];
  readonly entries: readonly DifferentialEntry[];
  readonly base_environment: EnvironmentFingerprint;
  readonly dependencies_reused: boolean;
  readonly note: string | null;
}

export interface DifferentialOptions {
  readonly exec: ExecFn;
  readonly repoRoot: string;
  readonly baseRef: string;
  readonly checks: readonly CheckSpec[];
  readonly candidateResults: readonly CheckResult[];
  readonly candidateEnvironment: EnvironmentFingerprint;
  readonly logDir: string;
  readonly logRoot?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly now?: (() => Date) | undefined;
}

// A verdict on the candidate says "failed"; the differential says whether the
// change introduced that failure or inherited it. Only an executed outcome on
// both sides can be compared: anything that did not run is not evidence.
export function classify(
  base: CheckStatus | null,
  candidate: CheckStatus,
): Classification {
  if (base === null) return "not-comparable";
  const basePassed = base === "passed";
  const baseFailed = base === "failed" || base === "timeout";
  const candidatePassed = candidate === "passed";
  const candidateFailed = candidate === "failed" || candidate === "timeout";
  if (basePassed && candidatePassed) return "stable";
  if (basePassed && candidateFailed) return "regression";
  if (baseFailed && candidateFailed) return "pre-existing";
  if (baseFailed && candidatePassed) return "fixed";
  return "not-comparable";
}

async function git(
  exec: ExecFn,
  cwd: string,
  args: readonly string[],
  options: { timeoutMs: number; signal?: AbortSignal | undefined },
): Promise<Result<string>> {
  const run = await exec("git", args, { cwd, ...options });
  if (!run.ok)
    return fail(
      run.error === "spawn-failed"
        ? "git is not installed"
        : `git ${args[0]} ${run.error}`,
    );
  if (run.value.code !== 0)
    return fail(
      `git ${args[0]} failed: ${run.value.stderr.trim().slice(0, 200)}`,
    );
  return ok(run.value.stdout);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

interface DependencyReuse {
  readonly reused: boolean;
  readonly note: string | null;
}

// Installing the base's dependencies is neither fast nor side-effect free, so
// the base borrows the candidate's node_modules when the lockfiles prove they
// resolve the same graph. Otherwise the base runs bare and says so.
async function shareNodeModules(
  repoRoot: string,
  worktree: string,
  base: EnvironmentFingerprint,
  candidate: EnvironmentFingerprint,
): Promise<DependencyReuse> {
  const source = join(repoRoot, "node_modules");
  const target = join(worktree, "node_modules");
  const explain = (reason: string): DependencyReuse => ({
    reused: false,
    note: `dependencies not reused (${reason}): base results may be unavailable or failed for lack of installed dependencies`,
  });
  if (!sameDependencies(base, candidate))
    return explain("base and candidate lockfiles differ");
  if (!(await isDirectory(source)))
    return explain("no node_modules in the candidate tree");
  if (await exists(target))
    return explain("base tree already carries a node_modules entry");
  await symlink(source, target, "dir");
  return { reused: true, note: null };
}

export async function runDifferential(
  options: DifferentialOptions,
): Promise<Result<Differential>> {
  const { exec, repoRoot, baseRef } = options;
  const resolved = await git(
    exec,
    repoRoot,
    ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`],
    { timeoutMs: 60_000 },
  );
  if (!resolved.ok) {
    return fail(`unknown base ref "${baseRef}": ${resolved.error}`);
  }
  const baseHead = resolved.value.trim();
  if (!/^[0-9a-f]{40,64}$/.test(baseHead)) {
    return fail(`unknown base ref "${baseRef}": no commit resolved`);
  }
  const worktree = await mkdtemp(join(tmpdir(), "evidence-base-"));
  let worktreeAdded = false;
  let linked = false;
  try {
    const added = await git(
      exec,
      repoRoot,
      ["worktree", "add", "--detach", worktree, baseHead],
      { timeoutMs: 300_000, signal: options.signal },
    );
    if (!added.ok)
      return fail(`cannot check out base ${baseHead}: ${added.error}`);
    worktreeAdded = true;
    const baseEnvironment = await fingerprintEnvironment(worktree);
    const reuse = await shareNodeModules(
      repoRoot,
      worktree,
      baseEnvironment,
      options.candidateEnvironment,
    );
    linked = reuse.reused;
    const baseResults = await runChecks(options.checks, {
      exec,
      repoRoot: worktree,
      logDir: join(options.logDir, "base"),
      logRoot: options.logRoot,
      signal: options.signal,
      now: options.now,
    });
    const byId = new Map(baseResults.map((r) => [r.id, r.status]));
    const entries = options.candidateResults.map((candidate) => {
      const baseStatus = byId.get(candidate.id) ?? null;
      return {
        id: candidate.id,
        base_status: baseStatus,
        candidate_status: candidate.status,
        classification: classify(baseStatus, candidate.status),
      };
    });
    return ok({
      base_ref: baseRef,
      base_head: baseHead,
      base_results: baseResults,
      entries,
      base_environment: baseEnvironment,
      dependencies_reused: reuse.reused,
      note: reuse.note,
    });
  } finally {
    // The symlink goes first: `worktree remove --force` would otherwise walk
    // into the candidate's node_modules and delete it.
    // Best-effort removals: a missing link or directory is not a failure of
    // the differential, and `rm` with force already tolerates absence.
    if (linked) await rm(join(worktree, "node_modules"), { force: true });
    if (worktreeAdded) {
      // Cleanup runs without the abort signal: an interrupted differential
      // must still leave the repository with no stray worktree.
      await git(exec, repoRoot, ["worktree", "remove", "--force", worktree], {
        timeoutMs: 120_000,
      });
      await git(exec, repoRoot, ["worktree", "prune"], { timeoutMs: 60_000 });
    }
    await rm(worktree, { recursive: true, force: true });
  }
}

export function summarizeDifferential(d: Differential): string[] {
  const lines = d.entries
    .filter((entry) => entry.classification !== "stable")
    .map(
      (entry) =>
        `${entry.id}: ${entry.classification} (base ${entry.base_status ?? "missing"}, candidate ${entry.candidate_status})`,
    );
  if (d.note !== null) lines.push(d.note);
  return lines;
}
