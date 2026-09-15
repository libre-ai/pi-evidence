// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import type { Dirent } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fail, ok, type Result } from "./result.ts";

export interface PruneOptions {
  readonly keep: number;
  readonly dryRun?: boolean | undefined;
}

export interface PruneReport {
  readonly removed: readonly string[];
  readonly kept: readonly string[];
}

// `<timestamp>-<sha7>[-n]` as produced by `bundleId` plus the same-second
// suffix. Anything else in the directory (recipe lock, user files) is never
// touched, whatever `keep` says: deletion is keyed on the id, not on the dir.
const BUNDLE_ID = /^\d{8}T\d{6}Z-[0-9a-f]{7}(?:-\d+)?$/;
const BUNDLE_SIDECAR =
  /^(\d{8}T\d{6}Z-[0-9a-f]{7}(?:-\d+)?)(?:\.intoto|\.dsse)?\.json$/;

export function isBundleId(name: string): boolean {
  return BUNDLE_ID.test(name);
}

// Files written next to a bundle: the record, its in-toto statement, its DSSE
// envelope, and the directory holding the full check logs.
function sidecarPaths(outputDir: string, id: string): readonly string[] {
  return [
    join(outputDir, `${id}.json`),
    join(outputDir, `${id}.intoto.json`),
    join(outputDir, `${id}.dsse.json`),
    join(outputDir, `${id}.acceptance.json`),
  ];
}

export async function pruneBundles(
  outputDir: string,
  options: PruneOptions,
): Promise<Result<PruneReport>> {
  if (!Number.isInteger(options.keep) || options.keep < 1)
    return fail(`prune: keep must be an integer >= 1, got ${options.keep}`);
  let entries: Dirent[];
  try {
    entries = await readdir(outputDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return ok({ removed: [], kept: [] });
    return fail(`prune: cannot read ${outputDir}: ${String(error)}`);
  }
  // A log directory without its record (interrupted run) still counts as a
  // bundle id: it is aged out with the others instead of lingering forever.
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (isBundleId(entry.name)) ids.add(entry.name);
      continue;
    }
    if (!entry.isFile()) continue;
    const match = BUNDLE_SIDECAR.exec(entry.name);
    const id = match?.[1];
    if (id !== undefined) ids.add(id);
  }
  // Ids start with a UTC timestamp, so lexical order is chronological.
  const sorted = [...ids].sort();
  const kept = sorted.slice(Math.max(0, sorted.length - options.keep));
  const removed = sorted.slice(0, Math.max(0, sorted.length - options.keep));
  if (options.dryRun === true) return ok({ removed, kept });
  for (const id of removed) {
    try {
      for (const file of sidecarPaths(outputDir, id))
        await rm(file, { force: true });
      await rm(join(outputDir, id), { force: true, recursive: true });
    } catch (error) {
      return fail(`prune: cannot remove ${id}: ${String(error)}`);
    }
  }
  return ok({ removed, kept });
}
