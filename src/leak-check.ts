// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { fail, ok, type Result } from "./result.ts";

// Leak check by reference values: after the fact, look for known values
// (a key, a path, a digest) byte for byte in a set of log files. It
// complements the pattern scrubber, which redacts generic token shapes at
// write time and knows nothing of the values a given run must not expose.
//
// Nothing here ever returns, formats or raises a reference value or a log
// excerpt: a report carries paths and counts only, so it can be printed in a
// public job. Deriving the variants of a value (with and without a path
// prefix, digests) belongs to whoever writes the reference file.

export interface LeakFile {
  readonly file: string;
  // Distinct reference values found in this file.
  readonly leaks: number;
}

export interface LeakReport {
  readonly files: number;
  readonly bytes: number;
  readonly reference: number;
  readonly leaks: number;
  readonly leaking: readonly LeakFile[];
}

const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;

// One value per line; `\n` and `\r\n` endings are removed, empty lines are
// ignored and duplicates collapse. Values stay bytes: a reference is not
// required to be valid UTF-8.
export function parseReference(bytes: Uint8Array): readonly Uint8Array[] {
  const values: Uint8Array[] = [];
  const seen = new Set<string>();
  let start = 0;
  while (start < bytes.length) {
    const feed = bytes.indexOf(LINE_FEED, start);
    const next = feed === -1 ? bytes.length : feed;
    const end =
      next > start && bytes[next - 1] === CARRIAGE_RETURN ? next - 1 : next;
    if (end > start) {
      const value = bytes.subarray(start, end);
      // latin1 maps each byte to one code unit: a lossless set key.
      const key = Buffer.from(value).toString("latin1");
      if (!seen.has(key)) {
        seen.add(key);
        values.push(value);
      }
    }
    start = next + 1;
  }
  return values;
}

function view(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function countLeaks(
  reference: readonly Uint8Array[],
  logs: readonly { readonly file: string; readonly bytes: Uint8Array }[],
): LeakReport {
  const needles = reference.map(view);
  const leaking: LeakFile[] = [];
  let bytes = 0;
  let leaks = 0;
  for (const log of logs) {
    const haystack = view(log.bytes);
    bytes += haystack.length;
    const found = needles.filter((needle) => haystack.includes(needle)).length;
    if (found > 0) {
      leaking.push({ file: log.file, leaks: found });
      leaks += found;
    }
  }
  return {
    files: logs.length,
    bytes,
    reference: reference.length,
    leaks,
    leaking,
  };
}

export function formatLeakReport(report: LeakReport): string {
  return [
    ...report.leaking.map((entry) => `${entry.file} leaks=${entry.leaks}`),
    `files=${report.files} bytes=${report.bytes} reference=${report.reference} leaks=${report.leaks}`,
  ].join("\n");
}

// A declared source that cannot be read is a failure, never an empty one. The
// error names a path and nothing else: the system message is dropped so that
// no content can ride on it.
export async function leakCheck(
  referencePath: string,
  logPaths: readonly string[],
): Promise<Result<LeakReport>> {
  let reference: readonly Uint8Array[];
  try {
    reference = parseReference(await readFile(referencePath));
  } catch {
    return fail(`cannot read reference ${referencePath}`);
  }
  const logs: { file: string; bytes: Uint8Array }[] = [];
  for (const file of logPaths) {
    try {
      logs.push({ file, bytes: await readFile(file) });
    } catch {
      return fail(`cannot read log ${file}`);
    }
  }
  return ok(countLeaks(reference, logs));
}
