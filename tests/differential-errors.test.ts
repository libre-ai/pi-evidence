// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDifferential } from "../src/differential.ts";
import { fingerprintEnvironment } from "../src/environment.ts";
import { fail } from "../src/result.ts";

describe("runDifferential tooling failures", () => {
  test("reports a missing git and a timed-out git without touching the tree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evidence-diff-err-"));
    const environment = await fingerprintEnvironment(dir);
    const base = {
      repoRoot: dir,
      baseRef: "HEAD",
      checks: [],
      candidateResults: [],
      candidateEnvironment: environment,
      logDir: join(dir, "logs"),
    };
    const missing = await runDifferential({
      ...base,
      exec: async () => fail("spawn-failed"),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("git is not installed");
    const timedOut = await runDifferential({
      ...base,
      exec: async () => fail("timeout"),
    });
    expect(timedOut.ok).toBe(false);
    if (!timedOut.ok) expect(timedOut.error).toContain("timeout");
  });
});
