// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { initRecipe } from "../src/init.ts";

describe("initRecipe", () => {
  test("writes a loadable recipe with no required check, refuses to overwrite without force", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evidence-init-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { lint: "x", test: "y" } }),
    );
    writeFileSync(join(dir, "bun.lock"), "");
    const result = await initRecipe(dir);
    expect(result.ok && result.value.checks).toEqual(["lint", "test"]);
    const loaded = await loadConfig(dir);
    expect(loaded.ok && loaded.value.kind).toBe("declared");
    if (loaded.ok && loaded.value.kind === "declared") {
      expect(
        loaded.value.config.checks.every((c) => c.required === false),
      ).toBe(true);
    }
    expect(readFileSync(join(dir, ".evidence.json"), "utf8")).toContain(
      "required: true",
    );
    expect((await initRecipe(dir)).ok).toBe(false);
    expect((await initRecipe(dir, { force: true })).ok).toBe(true);
    const empty = mkdtempSync(join(tmpdir(), "evidence-init-"));
    expect((await initRecipe(empty)).ok).toBe(false);
  });
});
