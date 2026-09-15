// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bundleId,
  type EvidenceBundle,
  listBundleIds,
  loadBundle,
  parseBundle,
  writeBundle,
} from "../src/bundle.ts";

export const sampleBundle = (
  id = "20260915T120000Z-abcdef0",
): EvidenceBundle => ({
  schema_version: 2,
  id,
  created_at: "2026-09-15T12:00:00.000Z",
  repository: { name: "repo", origin: null },
  revision: {
    head: "abcdef0123456789abcdef0123456789abcdef01",
    branch: "main",
    dirty: false,
    changed_files: [],
    status_sha256: "0".repeat(64),
    diff_sha256: "0".repeat(64),
  },
  recipe: {
    origin: "declared",
    hash: "1".repeat(64),
    checks: [
      {
        id: "t",
        command: "sh",
        args: ["-c", "true"],
        required: true,
        timeout_seconds: 600,
      },
    ],
    selected: ["t"],
  },
  results: [
    {
      id: "t",
      command: "sh",
      args: ["-c", "true"],
      required: true,
      status: "passed",
      exit_code: 0,
      started_at: "2026-09-15T12:00:00.000Z",
      duration_ms: 5,
      stdout_sha256: "2".repeat(64),
      stderr_sha256: "2".repeat(64),
      stdout_tail: "",
      stderr_tail: "",
      redactions: [],
      log_files: {
        stdout: "/repo/.evidence/x/t.stdout.log",
        stderr: "/repo/.evidence/x/t.stderr.log",
      },
    },
  ],
  verdict: "conformant",
  reasons: ["all required checks passed"],
  criteria_declared: true,
  requirement: null,
  environment: {
    platform: "darwin",
    arch: "arm64",
    lockfiles: {},
    node_modules_present: false,
    fingerprint_sha256: "3".repeat(64),
  },
  differential: null,
  session: { session_id: "s", provider: "p", model: "m", thinking_level: null },
  tools: { bun: "1.4.0", node: "v26.8.2", cargo: null },
});

describe("bundle", () => {
  test("ids sort chronologically and embed the short head", () => {
    const id = bundleId(
      new Date("2026-09-15T12:00:00.123Z"),
      "abcdef0123456789",
    );
    expect(id).toBe("20260915T120000Z-abcdef0");
    expect(
      bundleId(new Date("2026-09-16T00:00:00Z"), "x".repeat(40)) > id,
    ).toBe(true);
  });

  test("writes atomically, lists and reloads", async () => {
    const dir = join(
      mkdtempSync(join(tmpdir(), "evidence-bundle-")),
      ".evidence",
    );
    expect(await listBundleIds(dir)).toEqual([]);
    const file = await writeBundle(dir, sampleBundle());
    await writeBundle(dir, sampleBundle("20260915T130000Z-abcdef0"));
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(await listBundleIds(dir)).toEqual([
      "20260915T120000Z-abcdef0",
      "20260915T130000Z-abcdef0",
    ]);
    expect(await loadBundle(file)).toEqual({ ok: true, value: sampleBundle() });
    expect((await loadBundle(join(dir, "missing.json"))).ok).toBe(false);
    writeFileSync(join(dir, "bad.json"), "{");
    expect((await loadBundle(join(dir, "bad.json"))).ok).toBe(false);
    expect(parseBundle({ schema_version: 1 }).ok).toBe(false);
    expect(parseBundle({ ...sampleBundle(), verdict: "maybe" }).ok).toBe(false);
  });
});

describe("version 1 bundles", () => {
  test("are read with explicit empty v2 fields", () => {
    const v1 = {
      ...sampleBundle(),
      schema_version: 1,
      results: [{ ...sampleBundle().results[0], redactions: undefined }],
    } as unknown as Record<string, unknown>;
    delete v1.environment;
    delete v1.differential;
    delete v1.requirement;
    const parsed = parseBundle(v1);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.schema_version).toBe(2);
    expect(parsed.value.results[0]?.redactions).toEqual([]);
    expect(parsed.value.environment.platform).toBe("unknown");
    expect(parsed.value.differential).toBeNull();
    expect(parsed.value.requirement).toBeNull();
  });
});
