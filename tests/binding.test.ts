// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindRevision, collectToolVersions } from "../src/binding.ts";
import { runProcess } from "../src/exec.ts";
import { fail } from "../src/result.ts";

export function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "evidence-git-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.invalid",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.invalid",
      },
    });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  git("add", "README.md");
  git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
  return dir;
}

describe("bindRevision", () => {
  test("binds a clean repository, then detects modifications and untracked files", async () => {
    const dir = gitRepo();
    const clean = await bindRevision(runProcess, dir);
    expect(clean.ok).toBe(true);
    if (!clean.ok) return;
    expect(clean.value.head).toMatch(/^[0-9a-f]{40}$/);
    expect(clean.value.branch).toBe("main");
    expect(clean.value.dirty).toBe(false);
    expect(clean.value.changed_files).toEqual([]);
    writeFileSync(join(dir, "README.md"), "# changed\n");
    writeFileSync(join(dir, "new.txt"), "x\n");
    const dirty = await bindRevision(runProcess, dir);
    expect(dirty.ok).toBe(true);
    if (!dirty.ok) return;
    expect(dirty.value.dirty).toBe(true);
    expect(dirty.value.changed_files).toEqual(["README.md", "new.txt"]);
    expect(dirty.value.diff_sha256).not.toBe(clean.value.diff_sha256);
    expect(dirty.value.status_sha256).not.toBe(clean.value.status_sha256);
  });

  test("refuses a directory outside git and a repository without commits", async () => {
    const plain = mkdtempSync(join(tmpdir(), "evidence-plain-"));
    const result = await bindRevision(runProcess, plain);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not a git repository");
    const empty = mkdtempSync(join(tmpdir(), "evidence-empty-"));
    execFileSync("git", ["init", "-q"], { cwd: empty });
    const noCommit = await bindRevision(runProcess, empty);
    expect(noCommit.ok).toBe(false);
    const noGit = await bindRevision(async () => fail("spawn-failed"), plain);
    expect(noGit.ok).toBe(false);
  });
});

describe("collectToolVersions", () => {
  test("records available tool versions and null for missing ones", async () => {
    const versions = await collectToolVersions(runProcess, tmpdir());
    expect(versions.bun).toMatch(/^\d+\.\d+/);
    expect(versions.node).toMatch(/^v\d+/);
    const none = await collectToolVersions(
      async () => fail("spawn-failed"),
      tmpdir(),
    );
    expect(none).toEqual({ bun: null, node: null, cargo: null });
  });
});
