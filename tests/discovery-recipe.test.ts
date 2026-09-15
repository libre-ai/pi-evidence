// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverChecks } from "../src/discovery.ts";
import { recipeHash, resolveRecipe, selectChecks } from "../src/recipe.ts";

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "evidence-repo-"));
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(dir, name), content);
  return dir;
}

describe("discoverChecks", () => {
  test("uses bun when bun.lock exists, npm otherwise, and only known scripts", async () => {
    const withBun = repo({
      "package.json": JSON.stringify({
        scripts: { lint: "x", test: "y", build: "z" },
      }),
      "bun.lock": "",
    });
    expect(
      (await discoverChecks(withBun)).map(
        (c) => `${c.id}:${c.command} ${c.args.join(" ")}`,
      ),
    ).toEqual(["lint:bun run lint", "test:bun run test"]);
    const withNpm = repo({
      "package.json": JSON.stringify({ scripts: { check: "x" } }),
    });
    expect((await discoverChecks(withNpm))[0]?.command).toBe("npm");
    const withCargo = repo({ "Cargo.toml": '[package]\nname = "x"\n' });
    expect((await discoverChecks(withCargo)).map((c) => c.id)).toEqual([
      "cargo-test",
    ]);
    const broken = repo({ "package.json": "{nope" });
    expect(await discoverChecks(broken)).toEqual([]);
    const noScripts = repo({ "package.json": JSON.stringify({ name: "x" }) });
    expect(await discoverChecks(noScripts)).toEqual([]);
    expect(
      (await discoverChecks(withBun)).every((c) => c.required === false),
    ).toBe(true);
  });
});

describe("resolveRecipe", () => {
  test("prefers the declared recipe and hashes canonically", async () => {
    const dir = repo({
      ".evidence.json": JSON.stringify({
        schema_version: 1,
        checks: [
          { id: "t", command: "sh", args: ["-c", "true"], required: true },
        ],
      }),
      "package.json": JSON.stringify({ scripts: { test: "x" } }),
    });
    const recipe = await resolveRecipe(dir);
    expect(recipe.ok && recipe.value.origin).toBe("declared");
    expect(recipe.ok && recipe.value.checks.map((c) => c.id)).toEqual(["t"]);
    expect(recipe.ok && recipe.value.hash).toMatch(/^[0-9a-f]{64}$/);
    const same = recipeHash([
      {
        id: "t",
        command: "sh",
        args: ["-c", "true"],
        required: true,
        timeout_seconds: 600,
      },
    ]);
    expect(recipe.ok && recipe.value.hash).toBe(same);
    expect(
      recipeHash([
        {
          id: "t",
          command: "sh",
          args: ["-c", "false"],
          required: true,
          timeout_seconds: 600,
        },
      ]),
    ).not.toBe(same);
  });

  test("falls back to discovery, and fails when nothing is discoverable", async () => {
    const discovered = await resolveRecipe(
      repo({ "package.json": JSON.stringify({ scripts: { test: "x" } }) }),
    );
    expect(discovered.ok && discovered.value.origin).toBe("discovered");
    const nothing = await resolveRecipe(repo({}));
    expect(nothing.ok).toBe(false);
    const invalid = await resolveRecipe(repo({ ".evidence.json": "{}" }));
    expect(invalid.ok).toBe(false);
  });

  test("selects a subset of checks by id", async () => {
    const recipe = await resolveRecipe(
      repo({
        "package.json": JSON.stringify({ scripts: { lint: "a", test: "b" } }),
      }),
    );
    if (!recipe.ok) throw new Error(recipe.error);
    const subset = selectChecks(recipe.value, ["test"]);
    expect(subset.ok && subset.value.map((c) => c.id)).toEqual(["test"]);
    expect(
      selectChecks(recipe.value, []).ok && selectChecks(recipe.value, []),
    ).toEqual({ ok: true, value: recipe.value.checks });
    expect(selectChecks(recipe.value, ["nope"]).ok).toBe(false);
  });
});
