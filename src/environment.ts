// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface EnvironmentFingerprint {
  readonly platform: string;
  readonly arch: string;
  // Relative lockfile path -> sha256 of its content, for the lockfiles that
  // exist. Two trees with identical maps resolve the same dependency graph.
  readonly lockfiles: Readonly<Record<string, string>>;
  readonly node_modules_present: boolean;
  readonly fingerprint_sha256: string;
}

// Lockfiles recognised across the ecosystems the recipe discovery covers,
// plus the Python ones a check may rely on. Order is irrelevant: the map is
// canonicalised by sorted key before hashing.
export const LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "uv.lock",
  "poetry.lock",
  "requirements.txt",
] as const;

const sha256 = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

function isMissing(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function hashIfPresent(path: string): Promise<string | null> {
  try {
    return sha256(await readFile(path));
  } catch (error) {
    // Only absence is silent: an unreadable lockfile must surface rather than
    // be fingerprinted as "no lockfile".
    if (isMissing(error)) return null;
    throw error;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    // stat follows symlinks on purpose: a linked node_modules counts as present.
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export async function fingerprintEnvironment(
  repoRoot: string,
): Promise<EnvironmentFingerprint> {
  const lockfiles: Record<string, string> = {};
  for (const name of [...LOCKFILES].sort()) {
    const hash = await hashIfPresent(join(repoRoot, name));
    if (hash !== null) lockfiles[name] = hash;
  }
  const nodeModulesPresent = await isDirectory(join(repoRoot, "node_modules"));
  const canonical = JSON.stringify({
    arch: process.arch,
    lockfiles,
    node_modules_present: nodeModulesPresent,
    platform: process.platform,
  });
  return {
    platform: process.platform,
    arch: process.arch,
    lockfiles,
    node_modules_present: nodeModulesPresent,
    fingerprint_sha256: sha256(canonical),
  };
}

// Same lockfile set with the same content: installed dependencies from one
// tree are valid for the other, which is what makes sharing node_modules safe.
export function sameDependencies(
  a: EnvironmentFingerprint,
  b: EnvironmentFingerprint,
): boolean {
  const keysA = Object.keys(a.lockfiles).sort();
  const keysB = Object.keys(b.lockfiles).sort();
  if (keysA.length !== keysB.length) return false;
  return keysA.every(
    (key, index) =>
      key === keysB[index] && a.lockfiles[key] === b.lockfiles[key],
  );
}
