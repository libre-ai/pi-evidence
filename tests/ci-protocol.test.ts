// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { compareBundles } from "../src/compare.ts";
import { runProcess } from "../src/exec.ts";
import { EvidenceService } from "../src/service.ts";
import { gitRepo } from "./binding.test.ts";
import { sampleBundle } from "./bundle.test.ts";

const session = {
  session_id: "s",
  provider: "p",
  model: "m",
  thinking_level: null,
};
const env = {
  EVIDENCE_SESSION_ID: "ci",
  EVIDENCE_PROVIDER: "ci",
  EVIDENCE_MODEL: "none",
};

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      ...args,
    ],
    { cwd: dir, encoding: "utf8" },
  );
}

describe("evidence-only commit protocol", () => {
  test("compareBundles tolerates a HEAD difference only when asked", () => {
    const reference = sampleBundle("a");
    const candidate = {
      ...sampleBundle("b"),
      revision: { ...reference.revision, head: "f".repeat(40) },
    };
    expect(compareBundles(reference, candidate).outcome).toBe("stale");
    expect(
      compareBundles(reference, candidate, { headMayDiffer: true }).outcome,
    ).toBe("reproduced");
  });

  test("verifyForCi: same head, then evidence-only commit, then a code commit without reference", async () => {
    const dir = gitRepo();
    writeFileSync(join(dir, ".gitignore"), ".evidence/*\n!.evidence/*.json\n");
    writeFileSync(
      join(dir, ".evidence.json"),
      JSON.stringify({
        schema_version: 1,
        checks: [
          {
            id: "t",
            command: "sh",
            args: ["-c", "test -f ok.txt"],
            required: true,
          },
        ],
      }),
    );
    writeFileSync(join(dir, "ok.txt"), "");
    git(dir, "add", "-A", ".");
    git(dir, "commit", "-q", "-m", "code");
    const service = new EvidenceService({
      exec: runProcess,
      repoRoot: dir,
      env: {},
    });
    const nothing = await service.verifyForCi(session);
    expect(nothing.ok && nothing.value.kind).toBe("no-reference");

    const first = await service.run({
      only: [],
      session,
      acceptRecipe: { by: "dev" },
    });
    if (!first.ok) throw new Error(first.error);
    const untracked = await service.verifyForCi(session);
    // An untracked bundle is not a reference: only committed evidence counts.
    expect(untracked.ok && untracked.value.kind).toBe("no-reference");

    git(dir, "add", "-A", ".evidence");
    git(dir, "commit", "-q", "-m", "evidence for code");
    const evidenceOnly = await service.verifyForCi(session);
    expect(
      evidenceOnly.ok &&
        evidenceOnly.value.kind === "compared" &&
        evidenceOnly.value.protocol,
    ).toBe("evidence-only-commit");
    expect(
      evidenceOnly.ok &&
        evidenceOnly.value.kind === "compared" &&
        evidenceOnly.value.comparison.outcome,
    ).toBe("reproduced");

    const cliOk = { out: [] as string[], err: [] as string[] };
    expect(
      await runCli(
        ["verify", "--ci", "--json", "--cwd", dir],
        { stdout: (t) => cliOk.out.push(t), stderr: (t) => cliOk.err.push(t) },
        env,
      ),
    ).toBe(0);
    expect(JSON.parse(cliOk.out.join("")).protocol).toBe(
      "evidence-only-commit",
    );

    writeFileSync(join(dir, "code.txt"), "change\n");
    git(dir, "add", "-A", ".");
    git(dir, "commit", "-q", "-m", "more code");
    const noReference = await service.verifyForCi(session);
    expect(noReference.ok && noReference.value.kind).toBe("no-reference");
    const cliSkip = { out: [] as string[] };
    expect(
      await runCli(
        ["verify", "--ci", "--json", "--cwd", dir],
        { stdout: (t) => cliSkip.out.push(t), stderr: () => undefined },
        env,
      ),
    ).toBe(0);
    expect(JSON.parse(cliSkip.out.join("")).skipped).toBe(true);

    // A diverging replay in the evidence-only protocol fails the gate.
    const again = await service.run({ only: [], session });
    if (!again.ok) throw new Error(again.error);
    git(dir, "add", "-A", ".evidence");
    git(dir, "commit", "-q", "-m", "evidence for more code");
    execFileSync("rm", [join(dir, "ok.txt")]);
    git(dir, "add", "-A", ".");
    const diverged = await service.verifyForCi(session);
    // ok.txt removal is staged: the tree differs from the reference, so stale.
    expect(
      diverged.ok &&
        diverged.value.kind === "compared" &&
        diverged.value.comparison.outcome,
    ).toBe("stale");
    const cliFail = { out: [] as string[] };
    expect(
      await runCli(
        ["verify", "--ci", "--cwd", dir],
        { stdout: (t) => cliFail.out.push(t), stderr: () => undefined },
        env,
      ),
    ).toBe(1);
  });
});
