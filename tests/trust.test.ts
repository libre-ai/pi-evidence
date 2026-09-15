// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptRecipe,
  checkRecipePin,
  describePin,
  lockFile,
  readRecipeLock,
} from "../src/trust.ts";

describe("recipe pin", () => {
  test("unpinned, then pinned, then changed", async () => {
    const dir = join(
      mkdtempSync(join(tmpdir(), "evidence-trust-")),
      ".evidence",
    );
    expect(await checkRecipePin(dir, "a".repeat(64))).toEqual({
      ok: true,
      value: { state: "unpinned" },
    });
    const lock = await acceptRecipe(
      dir,
      "a".repeat(64),
      "tester",
      new Date("2026-09-15T12:00:00Z"),
    );
    expect(lock.accepted_by).toBe("tester");
    expect(await checkRecipePin(dir, "a".repeat(64))).toEqual({
      ok: true,
      value: { state: "pinned" },
    });
    const changed = await checkRecipePin(dir, "b".repeat(64));
    expect(changed.ok && changed.value.state).toBe("changed");
    expect(describePin({ state: "unpinned" }, "a".repeat(64))).toContain(
      "jamais acceptée",
    );
    expect(describePin({ state: "pinned" }, "a".repeat(64))).toContain(
      "épinglée",
    );
    if (changed.ok && changed.value.state === "changed") {
      expect(describePin(changed.value, "b".repeat(64))).toContain("tester");
    }
  });

  test("rejects a corrupt lock", async () => {
    const dir = join(
      mkdtempSync(join(tmpdir(), "evidence-trust-")),
      ".evidence",
    );
    await acceptRecipe(dir, "a".repeat(64), "t", new Date());
    writeFileSync(lockFile(dir), "{oops");
    expect((await readRecipeLock(dir)).ok).toBe(false);
    writeFileSync(lockFile(dir), JSON.stringify({ schema_version: 1 }));
    expect((await checkRecipePin(dir, "a".repeat(64))).ok).toBe(false);
  });
});
