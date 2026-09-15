// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { ExecFn } from "./exec.ts";
import { fail, ok, type Result } from "./result.ts";

export interface RevisionBinding {
  readonly head: string;
  readonly branch: string | null;
  readonly dirty: boolean;
  readonly changed_files: readonly string[];
  readonly status_sha256: string;
  readonly diff_sha256: string;
}

export interface ToolVersions {
  readonly [tool: string]: string | null;
}

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

async function git(
  exec: ExecFn,
  repoRoot: string,
  args: readonly string[],
): Promise<Result<string>> {
  const run = await exec("git", args, { cwd: repoRoot, timeoutMs: 60_000 });
  if (!run.ok)
    return fail(
      run.error === "spawn-failed"
        ? "git is not installed"
        : `git ${run.error}`,
    );
  if (run.value.code !== 0)
    return fail(
      `git ${args[0]} failed: ${run.value.stderr.trim().slice(0, 200)}`,
    );
  return ok(run.value.stdout);
}

// Evidence without a revision is an anecdote: the binding records HEAD and an
// exact fingerprint of what differs from it, so a bundle can be matched to the
// tree it was produced on.
export async function bindRevision(
  exec: ExecFn,
  repoRoot: string,
  excludePaths: readonly string[] = [],
): Promise<Result<RevisionBinding>> {
  const inside = await git(exec, repoRoot, [
    "rev-parse",
    "--is-inside-work-tree",
  ]);
  if (!inside.ok || inside.value.trim() !== "true") {
    return fail("not a git repository: evidence needs a revision to bind to");
  }
  const head = await git(exec, repoRoot, ["rev-parse", "HEAD"]);
  if (!head.ok) return fail("repository has no commit yet (HEAD unresolved)");
  const branch = await git(exec, repoRoot, [
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  // The evidence output directory is excluded: the run itself writes logs
  // there, and those bytes must not count as a change of the tree under test.
  const pathspec = ["--", ".", ...excludePaths.map((p) => `:(exclude)${p}`)];
  const status = await git(exec, repoRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    ...pathspec,
  ]);
  if (!status.ok) return status;
  const diff = await git(exec, repoRoot, [
    "diff",
    "HEAD",
    "--binary",
    "--no-ext-diff",
    ...pathspec,
  ]);
  if (!diff.ok) return diff;
  const changed = status.value
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3).trim())
    .sort();
  const branchName = branch.ok ? branch.value.trim() : "HEAD";
  return ok({
    head: head.value.trim(),
    branch: branchName === "HEAD" ? null : branchName,
    dirty: changed.length > 0,
    changed_files: changed,
    status_sha256: sha256(status.value),
    diff_sha256: sha256(diff.value),
  });
}

export const VERSIONED_TOOLS = ["bun", "node", "cargo"] as const;

export async function collectToolVersions(
  exec: ExecFn,
  repoRoot: string,
): Promise<ToolVersions> {
  const versions: Record<string, string | null> = {};
  for (const tool of VERSIONED_TOOLS) {
    const run = await exec(tool, ["--version"], {
      cwd: repoRoot,
      timeoutMs: 15_000,
    });
    versions[tool] =
      run.ok && run.value.code === 0
        ? (run.value.stdout.trim().split("\n")[0] ?? null)
        : null;
  }
  return versions;
}
