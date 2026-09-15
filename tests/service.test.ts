// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../src/exec.ts";
import { EvidenceService, resolveRepoRoot, summarize } from "../src/service.ts";
import { gitRepo } from "./binding.test.ts";

const session = {
  session_id: "s1",
  provider: "prov",
  model: "mod",
  thinking_level: "medium",
};

function declared(dir: string, checks: unknown[]): void {
  writeFileSync(
    join(dir, ".evidence.json"),
    JSON.stringify({ schema_version: 1, checks }),
  );
}

describe("EvidenceService", () => {
  test("declared recipe: conformant, then a deliberate defect fails with the check named", async () => {
    const dir = gitRepo();
    declared(dir, [
      {
        id: "lint",
        command: "sh",
        args: ["-c", "echo lint ok"],
        required: true,
      },
      {
        id: "test",
        command: "sh",
        args: ["-c", "test -f defect.flag && exit 1; echo tests ok"],
        required: true,
      },
    ]);
    const service = new EvidenceService({
      exec: runProcess,
      repoRoot: dir,
      now: () => new Date("2026-09-15T12:00:00Z"),
    });
    const config = await service.describeRecipe();
    expect(config.ok && config.value).toContain("critères déclarés : oui");
    const first = await service.run({ only: [], session });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.bundle.verdict).toBe("conformant");
    expect(first.value.bundle.criteria_declared).toBe(true);
    expect(first.value.bundle.revision.dirty).toBe(true); // .evidence.json is untracked
    expect(existsSync(first.value.file)).toBe(true);
    expect(
      readdirSync(join(dir, ".evidence", first.value.bundle.id)).sort(),
    ).toEqual([
      "lint.stderr.log",
      "lint.stdout.log",
      "test.stderr.log",
      "test.stdout.log",
    ]);
    expect(summarize(first.value.bundle)).toContain("CONFORMANT");

    writeFileSync(join(dir, "defect.flag"), "");
    const second = await service.run({
      only: [],
      session: { ...session, session_id: "s2" },
    });
    expect(second.ok && second.value.bundle.verdict).toBe("failed");
    expect(second.ok && second.value.bundle.reasons[0]).toBe(
      "test: failed (exit 1)",
    );

    const status = await service.status();
    expect(status.ok && status.value.split("\n")).toHaveLength(2);
    const shown = await service.show();
    expect(shown.ok && shown.value).toContain("FAILED");
    const specific = first.ok
      ? await service.show(first.value.bundle.id)
      : null;
    expect(specific?.ok && specific.value).toContain("CONFORMANT");
    expect((await service.show("nope")).ok).toBe(false);
    expect((await service.show("../x")).ok).toBe(false);
  });

  test("subset run is incomplete; required check unavailable is incomplete", async () => {
    const dir = gitRepo();
    declared(dir, [
      { id: "a", command: "sh", args: ["-c", "true"], required: true },
      { id: "b", command: "evidence-no-such-binary", args: [], required: true },
    ]);
    const service = new EvidenceService({ exec: runProcess, repoRoot: dir });
    const subset = await service.run({ only: ["a"], session });
    expect(subset.ok && subset.value.bundle.verdict).toBe("incomplete");
    const full = await service.run({ only: [], session });
    expect(full.ok && full.value.bundle.verdict).toBe("incomplete");
    expect(full.ok && full.value.bundle.results[1]?.status).toBe("unavailable");
    expect((await service.run({ only: ["zzz"], session })).ok).toBe(false);
  });

  test("discovered recipe is unverified at best; no recipe or no git is refused", async () => {
    const dir = gitRepo();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "echo discovered" } }),
    );
    writeFileSync(join(dir, "bun.lock"), "");
    const service = new EvidenceService({ exec: runProcess, repoRoot: dir });
    const run = await service.run({ only: [], session });
    expect(run.ok && run.value.bundle.verdict).toBe("unverified");
    expect(run.ok && run.value.bundle.recipe.origin).toBe("discovered");
    expect(run.ok && run.value.bundle.results[0]?.command).toBe("bun");
    const bare = new EvidenceService({ exec: runProcess, repoRoot: gitRepo() });
    expect((await bare.run({ only: [], session })).ok).toBe(false);
    expect((await bare.status()).ok).toBe(false);
    const plain = mkdtempSync(join(tmpdir(), "evidence-plain-"));
    declared(plain, [
      { id: "a", command: "sh", args: ["-c", "true"], required: true },
    ]);
    const noGit = new EvidenceService({ exec: runProcess, repoRoot: plain });
    expect((await noGit.run({ only: [], session })).ok).toBe(false);
    expect((await resolveRepoRoot(runProcess, plain)).ok).toBe(false);
    expect((await resolveRepoRoot(runProcess, join(dir))).ok).toBe(true);
  });

  test("verify reproduces on an unchanged tree and reports stale after a change", async () => {
    const dir = gitRepo();
    declared(dir, [
      { id: "a", command: "sh", args: ["-c", "true"], required: true },
    ]);
    const service = new EvidenceService({ exec: runProcess, repoRoot: dir });
    const first = await service.run({ only: [], session });
    if (!first.ok) throw new Error(first.error);
    const verified = await service.verify(undefined, session);
    expect(verified.ok && verified.value.comparison.outcome).toBe("reproduced");
    writeFileSync(join(dir, "README.md"), "# changed\n");
    const stale = await service.verify(first.value.bundle.id, session);
    expect(stale.ok && stale.value.comparison.outcome).toBe("stale");
    expect((await service.verify("missing", session)).ok).toBe(false);
  });

  test("a check that mutates the tree downgrades conformant to incomplete; abort marks aborted", async () => {
    const dir = gitRepo();
    declared(dir, [
      {
        id: "mutate",
        command: "sh",
        args: ["-c", "echo x >> README.md"],
        required: true,
      },
    ]);
    const service = new EvidenceService({ exec: runProcess, repoRoot: dir });
    const run = await service.run({ only: [], session });
    expect(run.ok && run.value.bundle.verdict).toBe("incomplete");
    expect(run.ok && run.value.bundle.reasons.at(-1)).toContain(
      "working tree changed",
    );
    declared(dir, [
      { id: "slow", command: "sh", args: ["-c", "sleep 5"], required: true },
      { id: "next", command: "sh", args: ["-c", "true"], required: true },
    ]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const aborted = await service.run({
      only: [],
      session,
      signal: controller.signal,
    });
    expect(
      aborted.ok && aborted.value.bundle.results.map((r) => r.status),
    ).toEqual(["aborted", "skipped"]);
    expect(aborted.ok && aborted.value.bundle.verdict).toBe("incomplete");
  });
});
