// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBundleId, pruneBundles } from "../src/prune.ts";

const IDS = [
  "20260901T100000Z-aaaaaaa",
  "20260902T100000Z-bbbbbbb",
  "20260902T100000Z-bbbbbbb-2",
  "20260903T100000Z-ccccccc",
  "20260904T100000Z-ddddddd",
] as const;

function evidenceDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "evidence-prune-"));
  for (const id of IDS) {
    writeFileSync(join(dir, `${id}.json`), "{}");
    writeFileSync(join(dir, `${id}.intoto.json`), "{}");
    mkdirSync(join(dir, id));
    writeFileSync(join(dir, id, "test.stdout.log"), "ok");
  }
  writeFileSync(join(dir, `${IDS[0]}.dsse.json`), "{}");
  writeFileSync(join(dir, "recipe.lock"), "keep me");
  writeFileSync(join(dir, "notes.json"), "{}");
  mkdirSync(join(dir, "unrelated-dir"));
  return dir;
}

describe("isBundleId", () => {
  test("accepts <timestamp>-<sha7>[-n] and nothing else", () => {
    for (const id of IDS) expect(isBundleId(id)).toBe(true);
    expect(isBundleId("recipe")).toBe(false);
    expect(isBundleId("20260901T100000Z-aaaaaa")).toBe(false);
    expect(isBundleId("20260901T100000Z-AAAAAAA")).toBe(false);
    expect(isBundleId("20260901T100000Z-aaaaaaa-x")).toBe(false);
    expect(isBundleId("../20260901T100000Z-aaaaaaa")).toBe(false);
  });
});

describe("pruneBundles", () => {
  test("keeps the newest bundles and removes older ones with sidecars", async () => {
    const dir = evidenceDir();
    const result = await pruneBundles(dir, { keep: 2 });
    expect(result).toEqual({
      ok: true,
      value: { removed: [IDS[0], IDS[1], IDS[2]], kept: [IDS[3], IDS[4]] },
    });
    for (const id of [IDS[0], IDS[1], IDS[2]]) {
      expect(existsSync(join(dir, `${id}.json`))).toBe(false);
      expect(existsSync(join(dir, `${id}.intoto.json`))).toBe(false);
      expect(existsSync(join(dir, id))).toBe(false);
    }
    expect(existsSync(join(dir, `${IDS[0]}.dsse.json`))).toBe(false);
    for (const id of [IDS[3], IDS[4]]) {
      expect(existsSync(join(dir, `${id}.json`))).toBe(true);
      expect(existsSync(join(dir, `${id}.intoto.json`))).toBe(true);
      expect(existsSync(join(dir, id, "test.stdout.log"))).toBe(true);
    }
    expect(existsSync(join(dir, "recipe.lock"))).toBe(true);
    expect(existsSync(join(dir, "notes.json"))).toBe(true);
    expect(existsSync(join(dir, "unrelated-dir"))).toBe(true);
  });

  test("dryRun reports the same plan without deleting", async () => {
    const dir = evidenceDir();
    const result = await pruneBundles(dir, { keep: 1, dryRun: true });
    expect(result).toEqual({
      ok: true,
      value: { removed: [IDS[0], IDS[1], IDS[2], IDS[3]], kept: [IDS[4]] },
    });
    for (const id of IDS) {
      expect(existsSync(join(dir, `${id}.json`))).toBe(true);
      expect(existsSync(join(dir, id))).toBe(true);
    }
  });

  test("keeps everything when keep covers all bundles", async () => {
    const dir = evidenceDir();
    const result = await pruneBundles(dir, { keep: 10 });
    expect(result).toEqual({
      ok: true,
      value: { removed: [], kept: [...IDS] },
    });
  });

  test("counts an orphan log directory as a bundle id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evidence-prune-"));
    mkdirSync(join(dir, IDS[0]));
    writeFileSync(join(dir, `${IDS[4]}.json`), "{}");
    const result = await pruneBundles(dir, { keep: 1 });
    expect(result).toEqual({
      ok: true,
      value: { removed: [IDS[0]], kept: [IDS[4]] },
    });
    expect(existsSync(join(dir, IDS[0]))).toBe(false);
  });

  test("refuses keep below 1 or non-integer", async () => {
    const dir = evidenceDir();
    for (const keep of [0, -1, 1.5, Number.NaN]) {
      const result = await pruneBundles(dir, { keep });
      expect(result.ok).toBe(false);
    }
    expect(existsSync(join(dir, `${IDS[0]}.json`))).toBe(true);
  });

  test("a missing directory prunes nothing and succeeds", async () => {
    const result = await pruneBundles(
      join(tmpdir(), "evidence-prune-missing-does-not-exist"),
      { keep: 1 },
    );
    expect(result).toEqual({ ok: true, value: { removed: [], kept: [] } });
  });

  test("a path that is not a directory fails", async () => {
    const dir = evidenceDir();
    const result = await pruneBundles(join(dir, "recipe.lock"), { keep: 1 });
    expect(result.ok).toBe(false);
  });
});
