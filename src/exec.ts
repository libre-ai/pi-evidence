// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { fail, ok, type Result } from "./result.ts";

export interface ProcessOutput {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export type ProcessError = "spawn-failed" | "timeout" | "aborted";

export interface ProcessOptions {
  readonly cwd?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  // Called with each chunk so a runner can keep full logs while capping memory.
  readonly onStdout?: ((chunk: string) => void) | undefined;
  readonly onStderr?: ((chunk: string) => void) | undefined;
  readonly maxCapturedBytes?: number | undefined;
  // Bytes written to the child's stdin, then closed; absent = stdin ignored.
  readonly stdin?: Uint8Array | undefined;
}

export type ExecFn = (
  command: string,
  args: readonly string[],
  options?: ProcessOptions,
) => Promise<Result<ProcessOutput, ProcessError>>;

export const DEFAULT_MAX_CAPTURED_BYTES = 64 * 1024;

// Node APIs only: Pi loads extensions under Node. Arguments travel as an array
// with shell disabled, so no recipe field can ever be interpreted by a shell.
export function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<Result<ProcessOutput, ProcessError>> {
  return new Promise((resolvePromise) => {
    if (options.signal?.aborted) {
      resolvePromise(fail("aborted"));
      return;
    }
    const startedAt = Date.now();
    const limit = options.maxCapturedBytes ?? DEFAULT_MAX_CAPTURED_BYTES;
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env === undefined ? process.env : { ...options.env },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (options.stdin !== undefined)
      child.stdin?.end(Buffer.from(options.stdin));
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: Result<ProcessOutput, ProcessError>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise(result);
    };
    const onAbort = (): void => {
      child.kill("SIGTERM");
      finish(fail("aborted"));
    };
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill("SIGTERM");
            finish(fail("timeout"));
          }, options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    // Captured text is capped (tail kept) so a chatty check cannot exhaust
    // memory; listeners still see every chunk for full logging.
    const keepTail = (current: string, chunk: string): string => {
      const next = current + chunk;
      return next.length > limit ? next.slice(next.length - limit) : next;
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      options.onStdout?.(chunk);
      stdout = keepTail(stdout, chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      options.onStderr?.(chunk);
      stderr = keepTail(stderr, chunk);
    });
    child.on("error", () => finish(fail("spawn-failed")));
    child.on("close", (code) => {
      finish(
        ok({
          code: code ?? -1,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
        }),
      );
    });
  });
}
