// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckSpec } from "../src/config.ts";
import { runProcess } from "../src/exec.ts";
import { runChecks } from "../src/runner.ts";
import { computeVerdict } from "../src/verdict.ts";

const spec = (
  id: string,
  script: string,
  required = true,
  timeout = 600,
): CheckSpec => ({
  id,
  command: "sh",
  args: ["-c", script],
  required,
  timeout_seconds: timeout,
});

describe("runChecks", () => {
  test("runs sequentially, logs full output, keeps tails and hashes", async () => {
    const logDir = join(mkdtempSync(join(tmpdir(), "evidence-run-")), "logs");
    const seen: string[] = [];
    const results = await runChecks(
      [
        spec("ok", "printf 'hello'"),
        spec("ko", "echo boom >&2; exit 2"),
        spec("missing", "true"),
      ],
      {
        exec: async (c, a, o) =>
          a[1] === "true"
            ? runProcess("evidence-no-such-binary", [], o)
            : runProcess(c, a, o),
        repoRoot: tmpdir(),
        logDir,
        onProgress: (r) => seen.push(r.id),
        tailBytes: 3,
      },
    );
    expect(seen).toEqual(["ok", "ko", "missing"]);
    expect(results.map((r) => r.status)).toEqual([
      "passed",
      "failed",
      "unavailable",
    ]);
    expect(results[0]?.stdout_tail).toBe("llo");
    expect(readFileSync(join(logDir, "ok.stdout.log"), "utf8")).toBe("hello");
    expect(results[0]?.stdout_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(results[1]?.exit_code).toBe(2);
    expect(results[1]?.stderr_tail).toContain("m\n");
    expect(results[2]?.exit_code).toBeNull();
  });

  test("marks a timeout, then an abort skips the remaining checks", async () => {
    const logDir = join(mkdtempSync(join(tmpdir(), "evidence-run-")), "logs");
    const slow = await runChecks([spec("slow", "sleep 5", true, 1)], {
      exec: runProcess,
      repoRoot: tmpdir(),
      logDir,
    });
    expect(slow[0]?.status).toBe("timeout");
    expect(slow[0]?.duration_ms).toBe(1000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const aborted = await runChecks(
      [spec("long", "sleep 5"), spec("after", "true")],
      {
        exec: runProcess,
        repoRoot: tmpdir(),
        logDir,
        signal: controller.signal,
      },
    );
    expect(aborted.map((r) => r.status)).toEqual(["aborted", "skipped"]);
    expect(aborted[1]?.log_files).toBeNull();
  });
});

describe("computeVerdict", () => {
  const result = (
    id: string,
    status:
      | "passed"
      | "failed"
      | "timeout"
      | "aborted"
      | "unavailable"
      | "skipped",
    required: boolean,
    exit: number | null = 0,
  ) => ({
    id,
    command: "sh",
    args: [],
    required,
    status,
    exit_code: exit,
    started_at: "t",
    duration_ms: 0,
    stdout_sha256: "",
    stderr_sha256: "",
    stdout_tail: "",
    stderr_tail: "",
    log_files: null,
  });

  test("applies precedence: failed, incomplete, conformant, unverified", () => {
    expect(
      computeVerdict(
        [result("a", "passed", true), result("b", "failed", false, 1)],
        "declared",
        true,
      ).verdict,
    ).toBe("failed");
    expect(
      computeVerdict([result("a", "timeout", true, null)], "declared", true)
        .verdict,
    ).toBe("failed");
    expect(
      computeVerdict(
        [result("a", "unavailable", true, null), result("b", "passed", true)],
        "declared",
        true,
      ).verdict,
    ).toBe("incomplete");
    expect(
      computeVerdict(
        [
          result("a", "aborted", true, null),
          result("b", "skipped", true, null),
        ],
        "declared",
        true,
      ).verdict,
    ).toBe("incomplete");
    const conformant = computeVerdict(
      [result("a", "passed", true), result("b", "passed", false)],
      "declared",
      true,
    );
    expect(conformant.verdict).toBe("conformant");
    expect(conformant.criteria_declared).toBe(true);
    expect(
      computeVerdict([result("a", "passed", true)], "declared", false).verdict,
    ).toBe("incomplete");
    const noCriteria = computeVerdict(
      [result("a", "passed", false)],
      "declared",
      true,
    );
    expect(noCriteria.verdict).toBe("unverified");
    expect(noCriteria.reasons.join(" ")).toContain("no required check");
    const discovered = computeVerdict(
      [result("a", "passed", false)],
      "discovered",
      true,
    );
    expect(discovered.verdict).toBe("unverified");
    expect(discovered.criteria_declared).toBe(false);
    expect(
      computeVerdict([result("a", "passed", false)], "discovered", false)
        .verdict,
    ).toBe("unverified");
    expect(
      computeVerdict(
        [result("a", "unavailable", false, null)],
        "discovered",
        true,
      ).verdict,
    ).toBe("unverified");
  });

  test("an interrupted run is never conformant; an optional unavailable check is", () => {
    const interrupted = computeVerdict(
      [result("a", "passed", true), result("b", "aborted", false, null)],
      "declared",
      true,
    );
    expect(interrupted.verdict).toBe("incomplete");
    expect(interrupted.reasons).toContain("b: aborted (run interrupted)");
    const optionalMissing = computeVerdict(
      [result("a", "passed", true), result("b", "unavailable", false, null)],
      "declared",
      true,
    );
    expect(optionalMissing.verdict).toBe("conformant");
    expect(optionalMissing.reasons).toContain("b: optional check unavailable");
  });
});
