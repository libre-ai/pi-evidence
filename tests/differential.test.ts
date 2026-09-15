// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { CheckSpec } from "../src/config.ts";
import { runDifferential, summarizeDifferential } from "../src/differential.ts";
import { fingerprintEnvironment } from "../src/environment.ts";
import { runProcess } from "../src/exec.ts";
import { type CheckResult, runChecks } from "../src/runner.ts";
import { gitRepo } from "./binding.test.ts";

const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });

const commitAll = (dir: string, message: string): void => {
  git(dir, "add", "-A");
  git(dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
};

// Base = HEAD carries `committed`; the candidate working tree carries
// `working` uncommitted, so the same check reads different content on each
// side without any dependency on the package's own recipe.
function repoWithMarker(committed: string, working: string): string {
  const dir = gitRepo();
  writeFileSync(join(dir, "marker.txt"), `${committed}\n`);
  commitAll(dir, "marker");
  writeFileSync(join(dir, "marker.txt"), `${working}\n`);
  return dir;
}

const spec = (id: string, script: string, command = "sh"): CheckSpec => ({
  id,
  command,
  args: ["-c", script],
  required: true,
  timeout_seconds: 60,
});

const MARKER_CHECK = spec("marker", "grep -q ok marker.txt");

// git prints real paths (`/private/var` on macOS) while tmpdir() may be a
// symlinked alias, so both sides are resolved before comparing.
const worktrees = (dir: string): string[] =>
  git(dir, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => realpathSync(line.slice("worktree ".length)));

async function differentialOf(
  dir: string,
  checks: readonly CheckSpec[],
  baseRef = "HEAD",
  candidateOverride?: readonly CheckResult[],
) {
  const logDir = join(dir, ".evidence", "logs");
  const candidateResults =
    candidateOverride ??
    (await runChecks(checks, {
      exec: runProcess,
      repoRoot: dir,
      logDir: join(logDir, "candidate"),
    }));
  const candidateEnvironment = await fingerprintEnvironment(dir);
  return runDifferential({
    exec: runProcess,
    repoRoot: dir,
    baseRef,
    checks,
    candidateResults,
    candidateEnvironment,
    logDir,
  });
}

describe("runDifferential", () => {
  test("classifies a regression and removes the temporary worktree", async () => {
    const dir = repoWithMarker("ok", "ko");
    const statusBefore = git(dir, "status", "--porcelain");
    const result = await differentialOf(dir, [MARKER_CHECK]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.base_ref).toBe("HEAD");
    expect(result.value.base_head).toBe(git(dir, "rev-parse", "HEAD").trim());
    expect(result.value.entries).toEqual([
      {
        id: "marker",
        base_status: "passed",
        candidate_status: "failed",
        classification: "regression",
      },
    ]);
    expect(result.value.base_results[0]?.log_files?.stdout).toBe(
      join(dir, ".evidence", "logs", "base", "marker.stdout.log"),
    );
    expect(
      existsSync(join(dir, ".evidence", "logs", "base", "marker.stdout.log")),
    ).toBe(true);
    expect(summarizeDifferential(result.value)).toEqual([
      "marker: regression (base passed, candidate failed)",
      "dependencies not reused (no node_modules in the candidate tree): base results may be unavailable or failed for lack of installed dependencies",
    ]);
    expect(worktrees(dir)).toEqual([realpathSync(dir)]);
    // The differential reads the candidate tree; it never writes into it
    // (the .evidence log directory is the caller's, not the tree under test).
    expect(
      git(dir, "status", "--porcelain", "--", ".", ":(exclude).evidence"),
    ).toBe(statusBefore);
    expect(readFileSync(join(dir, "marker.txt"), "utf8")).toBe("ko\n");
  });

  test("classifies pre-existing, fixed and stable outcomes", async () => {
    const preExisting = await differentialOf(repoWithMarker("ko", "ko"), [
      MARKER_CHECK,
    ]);
    expect(preExisting.ok && preExisting.value.entries[0]?.classification).toBe(
      "pre-existing",
    );
    const fixed = await differentialOf(repoWithMarker("ko", "ok"), [
      MARKER_CHECK,
    ]);
    expect(fixed.ok && fixed.value.entries[0]?.classification).toBe("fixed");
    const stable = await differentialOf(repoWithMarker("ok", "ok"), [
      MARKER_CHECK,
    ]);
    expect(stable.ok && stable.value.entries[0]?.classification).toBe("stable");
    if (stable.ok) {
      const lines = summarizeDifferential(stable.value);
      expect(lines.some((line) => line.startsWith("marker:"))).toBe(false);
    }
  });

  test("accepts a symbolic base ref and refuses an unknown one", async () => {
    const dir = repoWithMarker("ok", "ko");
    git(dir, "tag", "v-base");
    const byTag = await differentialOf(dir, [MARKER_CHECK], "v-base");
    expect(byTag.ok && byTag.value.entries[0]?.classification).toBe(
      "regression",
    );
    const unknown = await differentialOf(dir, [MARKER_CHECK], "no-such-ref");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok)
      expect(unknown.error).toContain('unknown base ref "no-such-ref"');
    expect(worktrees(dir)).toEqual([realpathSync(dir)]);
  });

  test("reports not-comparable when a side did not execute or the base lacks the check", async () => {
    const dir = repoWithMarker("ok", "ok");
    const missing = spec("missing", "true", "evidence-no-such-binary");
    const checks = [MARKER_CHECK, missing];
    const candidate = await runChecks(checks, {
      exec: runProcess,
      repoRoot: dir,
      logDir: join(dir, ".evidence", "logs", "candidate"),
    });
    const extra: CheckResult = {
      ...(candidate[0] as CheckResult),
      id: "extra",
    };
    const result = await differentialOf(dir, checks, "HEAD", [
      ...candidate,
      extra,
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.entries.map((e) => [e.id, e.base_status, e.classification]),
    ).toEqual([
      ["marker", "passed", "stable"],
      ["missing", "unavailable", "not-comparable"],
      ["extra", null, "not-comparable"],
    ]);
    expect(summarizeDifferential(result.value)).toContain(
      "extra: not-comparable (base missing, candidate passed)",
    );
  });

  test("shares node_modules with the base when the lockfiles match", async () => {
    const dir = gitRepo();
    writeFileSync(join(dir, "bun.lock"), "lock-a\n");
    commitAll(dir, "lockfile");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "marker"), "installed\n");
    const check = spec("deps", "test -f node_modules/marker");
    const result = await differentialOf(dir, [check]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dependencies_reused).toBe(true);
    expect(result.value.note).toBeNull();
    expect(result.value.base_environment.lockfiles).toEqual(
      (await fingerprintEnvironment(dir)).lockfiles,
    );
    // Fingerprinted before the link: the base tree itself had nothing installed.
    expect(result.value.base_environment.node_modules_present).toBe(false);
    expect(result.value.entries[0]?.classification).toBe("stable");
    // Removing the link must not remove what it pointed to.
    expect(existsSync(join(dir, "node_modules", "marker"))).toBe(true);
    expect(worktrees(dir)).toEqual([realpathSync(dir)]);
  });

  test("runs the base bare when the lockfiles differ", async () => {
    const dir = gitRepo();
    writeFileSync(join(dir, "bun.lock"), "lock-a\n");
    commitAll(dir, "lockfile");
    writeFileSync(join(dir, "bun.lock"), "lock-b\n");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "marker"), "installed\n");
    const check = spec("deps", "test -f node_modules/marker");
    const result = await differentialOf(dir, [check]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dependencies_reused).toBe(false);
    expect(result.value.note).toContain("lockfiles differ");
    expect(result.value.entries[0]).toEqual({
      id: "deps",
      base_status: "failed",
      candidate_status: "passed",
      classification: "fixed",
    });
    expect(existsSync(join(dir, "node_modules", "marker"))).toBe(true);
  });
});
