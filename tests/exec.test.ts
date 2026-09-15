// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { runProcess } from "../src/exec.ts";

describe("runProcess", () => {
  test("captures output, code and duration", async () => {
    const result = await runProcess("sh", [
      "-c",
      "echo out; echo err >&2; exit 3",
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.code).toBe(3);
    expect(result.value.stdout).toBe("out\n");
    expect(result.value.stderr).toBe("err\n");
    expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("keeps only the tail beyond the capture limit but streams every chunk", async () => {
    const chunks: string[] = [];
    const result = await runProcess("sh", ["-c", "printf 'abcdefghij'"], {
      maxCapturedBytes: 4,
      onStdout: (chunk) => chunks.push(chunk),
    });
    expect(result.ok && result.value.stdout).toBe("ghij");
    expect(chunks.join("")).toBe("abcdefghij");
  });

  test("reports a missing executable, a timeout and an abort", async () => {
    expect(await runProcess("evidence-no-such-binary", [])).toEqual({
      ok: false,
      error: "spawn-failed",
    });
    expect(
      await runProcess("sh", ["-c", "sleep 5"], { timeoutMs: 100 }),
    ).toEqual({ ok: false, error: "timeout" });
    const controller = new AbortController();
    const pending = runProcess("sh", ["-c", "sleep 5"], {
      signal: controller.signal,
    });
    controller.abort();
    expect(await pending).toEqual({ ok: false, error: "aborted" });
    expect(
      await runProcess("sh", ["-c", "true"], { signal: controller.signal }),
    ).toEqual({ ok: false, error: "aborted" });
  });
});

describe("runProcess stdin", () => {
  test("feeds bytes to the child's standard input", async () => {
    const result = await runProcess("cat", [], {
      stdin: new TextEncoder().encode("piped\n"),
    });
    expect(result.ok && result.value.stdout).toBe("piped\n");
  });
});
