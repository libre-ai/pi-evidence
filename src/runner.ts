// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CheckSpec } from "./config.ts";
import type { ExecFn } from "./exec.ts";

export type CheckStatus =
  | "passed"
  | "failed"
  | "timeout"
  | "aborted"
  | "unavailable"
  | "skipped";

export interface CheckResult {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly required: boolean;
  readonly status: CheckStatus;
  readonly exit_code: number | null;
  readonly started_at: string;
  readonly duration_ms: number;
  readonly stdout_sha256: string;
  readonly stderr_sha256: string;
  readonly stdout_tail: string;
  readonly stderr_tail: string;
  readonly log_files: {
    readonly stdout: string;
    readonly stderr: string;
  } | null;
}

export interface RunOptions {
  readonly exec: ExecFn;
  readonly repoRoot: string;
  readonly logDir: string;
  readonly signal?: AbortSignal | undefined;
  readonly now?: (() => Date) | undefined;
  readonly onProgress?: ((result: CheckResult) => void) | undefined;
  readonly tailBytes?: number | undefined;
}

const DEFAULT_TAIL = 2048;

function openLog(path: string): WriteStream {
  return createWriteStream(path, { flags: "w" });
}

function closeLog(stream: WriteStream): Promise<void> {
  return new Promise((resolve) => stream.end(() => resolve()));
}

// Checks run one at a time in declaration order. Every byte of output lands
// in a log file and in a hash; the bundle keeps only a tail inline.
export async function runChecks(
  checks: readonly CheckSpec[],
  options: RunOptions,
): Promise<CheckResult[]> {
  await mkdir(options.logDir, { recursive: true });
  const results: CheckResult[] = [];
  const tail = options.tailBytes ?? DEFAULT_TAIL;
  let abortedEarlier = false;
  for (const check of checks) {
    const startedAt = (options.now ?? (() => new Date()))().toISOString();
    if (abortedEarlier || options.signal?.aborted) {
      const skipped: CheckResult = {
        id: check.id,
        command: check.command,
        args: check.args,
        required: check.required,
        status: "skipped",
        exit_code: null,
        started_at: startedAt,
        duration_ms: 0,
        stdout_sha256: sha256Of(""),
        stderr_sha256: sha256Of(""),
        stdout_tail: "",
        stderr_tail: "",
        log_files: null,
      };
      results.push(skipped);
      options.onProgress?.(skipped);
      continue;
    }
    const stdoutPath = join(options.logDir, `${check.id}.stdout.log`);
    const stderrPath = join(options.logDir, `${check.id}.stderr.log`);
    const stdoutLog = openLog(stdoutPath);
    const stderrLog = openLog(stderrPath);
    const stdoutHash = createHash("sha256");
    const stderrHash = createHash("sha256");
    const run = await options.exec(check.command, check.args, {
      cwd: options.repoRoot,
      timeoutMs: check.timeout_seconds * 1000,
      signal: options.signal,
      maxCapturedBytes: tail,
      onStdout: (chunk) => {
        stdoutLog.write(chunk);
        stdoutHash.update(chunk);
      },
      onStderr: (chunk) => {
        stderrLog.write(chunk);
        stderrHash.update(chunk);
      },
    });
    await Promise.all([closeLog(stdoutLog), closeLog(stderrLog)]);
    let status: CheckStatus;
    let exitCode: number | null = null;
    let duration = 0;
    let stdoutTail = "";
    let stderrTail = "";
    if (run.ok) {
      exitCode = run.value.code;
      duration = run.value.durationMs;
      stdoutTail = run.value.stdout;
      stderrTail = run.value.stderr;
      status = run.value.code === 0 ? "passed" : "failed";
    } else if (run.error === "spawn-failed") {
      status = "unavailable";
    } else if (run.error === "timeout") {
      status = "timeout";
      duration = check.timeout_seconds * 1000;
    } else {
      status = "aborted";
      abortedEarlier = true;
    }
    const result: CheckResult = {
      id: check.id,
      command: check.command,
      args: check.args,
      required: check.required,
      status,
      exit_code: exitCode,
      started_at: startedAt,
      duration_ms: duration,
      stdout_sha256: stdoutHash.digest("hex"),
      stderr_sha256: stderrHash.digest("hex"),
      stdout_tail: stdoutTail,
      stderr_tail: stderrTail,
      log_files: { stdout: stdoutPath, stderr: stderrPath },
    };
    results.push(result);
    options.onProgress?.(result);
  }
  return results;
}

function sha256Of(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
