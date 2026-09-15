// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../src/exec.ts";
import { EvidenceService } from "../src/service.ts";
import { createSshSigner } from "../src/signer.ts";
import { gitRepo } from "./binding.test.ts";

const session = {
  session_id: "s",
  provider: "p",
  model: "m",
  thinking_level: null,
};

function ephemeralKey(): { keyPath: string; allowedSigners: string } {
  const dir = mkdtempSync(join(tmpdir(), "evidence-key-"));
  const keyPath = join(dir, "key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath]);
  const pub = readFileSync(`${keyPath}.pub`, "utf8").trim();
  const allowedSigners = join(dir, "allowed_signers");
  writeFileSync(allowedSigners, `tester ${pub}\n`);
  return { keyPath, allowedSigners };
}

function commit(dir: string, message: string): void {
  execFileSync("git", ["add", "-A", "."], { cwd: dir });
  execFileSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "commit",
      "-q",
      "-m",
      message,
    ],
    { cwd: dir },
  );
}

describe("service v2", () => {
  test("signs the attestation with an ephemeral SSH key, verifies it, and records a signed decision", async () => {
    const dir = gitRepo();
    writeFileSync(
      join(dir, ".evidence.json"),
      JSON.stringify({
        schema_version: 1,
        checks: [
          {
            id: "t",
            command: "sh",
            args: ["-c", "echo token=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
            required: true,
          },
        ],
      }),
    );
    const { keyPath, allowedSigners } = ephemeralKey();
    const service = new EvidenceService({
      exec: runProcess,
      repoRoot: dir,
      env: {
        EVIDENCE_SSH_KEY: keyPath,
        EVIDENCE_ALLOWED_SIGNERS: allowedSigners,
      },
    });
    const run = await service.run({
      only: [],
      session,
      acceptRecipe: { by: "t" },
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.value.attestation?.keyid).toMatch(/^SHA256:/);
    expect(run.value.attestation?.envelope).not.toBeNull();
    expect(run.value.bundle.results[0]?.redactions).toEqual([
      { family: "github-token", count: 1 },
    ]);
    expect(run.value.bundle.results[0]?.stdout_tail).toContain(
      "[REDACTED:github-token]",
    );
    expect(
      readFileSync(
        join(dir, ".evidence", run.value.bundle.id, "t.stdout.log"),
        "utf8",
      ),
    ).toContain("[REDACTED:github-token]");
    const shown = await service.show();
    expect(shown.ok && shown.value).toContain("vérifiée");
    const status = await service.status();
    expect(status.ok && status.value).toContain("signé, vérifié");
    const decided = await service.accept(undefined, "alice", "accepted", "ok");
    expect(decided.ok && decided.value.signature?.keyid).toBe(
      run.value.attestation?.keyid ?? "",
    );

    // Tampering with the statement on disk must surface as INVALID.
    const statementFile = run.value.attestation?.statement ?? "";
    writeFileSync(
      statementFile,
      readFileSync(statementFile, "utf8").replace("conformant", "failed"),
    );
    const tampered = await service.show();
    expect(tampered.ok && tampered.value).toContain("INVALIDE");
  });

  test("falls back to an unsigned attestation when no key resolves, and the signer factory seam works", async () => {
    const dir = gitRepo();
    writeFileSync(
      join(dir, ".evidence.json"),
      JSON.stringify({
        schema_version: 1,
        checks: [
          { id: "t", command: "sh", args: ["-c", "true"], required: true },
        ],
      }),
    );
    const unsigned = new EvidenceService({
      exec: runProcess,
      repoRoot: dir,
      env: {},
    });
    const run = await unsigned.run({
      only: [],
      session,
      acceptRecipe: { by: "t" },
    });
    expect(run.ok && run.value.attestation?.keyid).toBeNull();
    const { keyPath } = ephemeralKey();
    const seeded = new EvidenceService({
      exec: runProcess,
      repoRoot: dir,
      env: {},
      signerFactory: async () => {
        const signer = await createSshSigner(runProcess, { keyPath });
        return signer.ok ? signer.value : null;
      },
    });
    const signedRun = await seeded.run({ only: [], session });
    expect(signedRun.ok && signedRun.value.attestation?.keyid).toMatch(
      /^SHA256:/,
    );
    const shownNoVerifier = await seeded.show();
    expect(shownNoVerifier.ok && shownNoVerifier.value).toContain(
      "non vérifiée",
    );
  });

  test("differential run classifies a regression against the base commit", async () => {
    const dir = gitRepo();
    writeFileSync(join(dir, "marker.txt"), "ok\n");
    writeFileSync(
      join(dir, ".evidence.json"),
      JSON.stringify({
        schema_version: 1,
        checks: [
          {
            id: "marker",
            command: "sh",
            args: ["-c", "grep -q ok marker.txt"],
            required: true,
          },
        ],
      }),
    );
    commit(dir, "base");
    writeFileSync(join(dir, "marker.txt"), "ko\n");
    const service = new EvidenceService({
      exec: runProcess,
      repoRoot: dir,
      env: {},
    });
    const run = await service.run({
      only: [],
      session,
      acceptRecipe: { by: "t" },
      baseRef: "HEAD",
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.value.bundle.verdict).toBe("failed");
    expect(run.value.bundle.differential?.entries[0]?.classification).toBe(
      "regression",
    );
    const shown = await service.show();
    expect(shown.ok && shown.value).toContain("regression");
    expect(
      (await service.run({ only: [], session, baseRef: "no-such-ref" })).ok,
    ).toBe(false);
  });

  test("init, prune and attach through the service", async () => {
    const dir = gitRepo();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { check: "true" } }),
    );
    const service = new EvidenceService({
      exec: runProcess,
      repoRoot: dir,
      env: {},
    });
    const init = await service.init(false);
    expect(init.ok && init.value).toContain(".evidence.json");
    expect((await service.init(false)).ok).toBe(false);
    for (let i = 0; i < 3; i += 1) {
      const run = await service.run({
        only: [],
        session,
        acceptRecipe: { by: "t" },
      });
      expect(run.ok && run.value.bundle.verdict).toBe("unverified");
    }
    const pruned = await service.prune(1, false);
    expect(pruned.ok && pruned.value.removed).toHaveLength(2);
    expect((await service.prune(0, false)).ok).toBe(false);
    const report = join(dir, "r.md");
    writeFileSync(report, "Verdict: BLOCKED\n");
    const attached = await service.attach(undefined, "report", report);
    expect(attached.ok && attached.value.report_verdict).toBe("BLOCKED");
    expect((await service.attach("nope", "report", report)).ok).toBe(false);
  });
});
