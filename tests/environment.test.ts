// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EnvironmentFingerprint,
  fingerprintEnvironment,
  sameDependencies,
} from "../src/environment.ts";

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

describe("fingerprintEnvironment", () => {
  test("an empty tree has no lockfile, no node_modules, and a stable fingerprint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evidence-env-"));
    const first = await fingerprintEnvironment(dir);
    expect(first.platform).toBe(process.platform);
    expect(first.arch).toBe(process.arch);
    expect(first.lockfiles).toEqual({});
    expect(first.node_modules_present).toBe(false);
    expect(first.fingerprint_sha256).toMatch(/^[0-9a-f]{64}$/);
    const second = await fingerprintEnvironment(dir);
    expect(second).toEqual(first);
  });

  test("hashes only the lockfiles that exist and detects node_modules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evidence-env-"));
    writeFileSync(join(dir, "bun.lock"), "lock-a\n");
    writeFileSync(join(dir, "Cargo.lock"), "cargo-a\n");
    writeFileSync(join(dir, "unrelated.lock"), "ignored\n");
    const bare = await fingerprintEnvironment(dir);
    expect(bare.lockfiles).toEqual({
      "Cargo.lock": sha256("cargo-a\n"),
      "bun.lock": sha256("lock-a\n"),
    });
    expect(bare.node_modules_present).toBe(false);
    mkdirSync(join(dir, "node_modules"));
    const installed = await fingerprintEnvironment(dir);
    expect(installed.node_modules_present).toBe(true);
    expect(installed.lockfiles).toEqual(bare.lockfiles);
    expect(installed.fingerprint_sha256).not.toBe(bare.fingerprint_sha256);
    writeFileSync(join(dir, "bun.lock"), "lock-b\n");
    const changed = await fingerprintEnvironment(dir);
    expect(changed.lockfiles["bun.lock"]).toBe(sha256("lock-b\n"));
    expect(changed.fingerprint_sha256).not.toBe(installed.fingerprint_sha256);
  });
});

describe("sameDependencies", () => {
  const fp = (
    lockfiles: Record<string, string>,
    nodeModules = false,
  ): EnvironmentFingerprint => ({
    platform: "test",
    arch: "test",
    lockfiles,
    node_modules_present: nodeModules,
    fingerprint_sha256: "irrelevant",
  });

  test("compares the lockfile maps and nothing else", () => {
    expect(sameDependencies(fp({}), fp({}))).toBe(true);
    expect(
      sameDependencies(fp({ "bun.lock": "a" }), fp({ "bun.lock": "a" })),
    ).toBe(true);
    expect(
      sameDependencies(
        fp({ "bun.lock": "a" }, false),
        fp({ "bun.lock": "a" }, true),
      ),
    ).toBe(true);
    expect(
      sameDependencies(fp({ "bun.lock": "a" }), fp({ "bun.lock": "b" })),
    ).toBe(false);
    expect(sameDependencies(fp({ "bun.lock": "a" }), fp({}))).toBe(false);
    expect(
      sameDependencies(
        fp({ "bun.lock": "a" }),
        fp({ "bun.lock": "a", "Cargo.lock": "c" }),
      ),
    ).toBe(false);
    expect(
      sameDependencies(fp({ "bun.lock": "a" }), fp({ "Cargo.lock": "a" })),
    ).toBe(false);
  });
});
