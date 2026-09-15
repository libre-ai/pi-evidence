// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseConfig } from "../src/config.ts";

const valid = {
  schema_version: 1,
  checks: [
    { id: "lint", command: "bun", args: ["run", "lint"], required: true },
    { id: "test", command: "bun", args: ["test"], timeout_seconds: 30 },
  ],
};

describe("parseConfig", () => {
  test("accepts a valid recipe and applies defaults", () => {
    const result = parseConfig(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.output_dir).toBe(".evidence");
    expect(result.value.checks[0]?.timeout_seconds).toBe(600);
    expect(result.value.checks[1]?.required).toBe(false);
    expect(result.value.checks[1]?.timeout_seconds).toBe(30);
  });

  test("rejects malformed recipes with a precise reason", () => {
    const cases: [unknown, string][] = [
      [{ schema_version: 2, checks: [] }, "schema_version"],
      [{ schema_version: 1, checks: [] }, "non-empty"],
      [{ schema_version: 1, checks: [{ id: "Bad Id", command: "bun" }] }, "id"],
      [
        { schema_version: 1, checks: [{ id: "x", command: "bun run lint" }] },
        "bare executable",
      ],
      [
        { schema_version: 1, checks: [{ id: "x", command: "../bin/x" }] },
        "bare executable",
      ],
      [
        {
          schema_version: 1,
          checks: [{ id: "x", command: "bun", args: "lint" }],
        },
        "args",
      ],
      [
        {
          schema_version: 1,
          checks: [{ id: "x", command: "bun", required: "yes" }],
        },
        "required",
      ],
      [
        {
          schema_version: 1,
          checks: [{ id: "x", command: "bun", timeout_seconds: 0 }],
        },
        "timeout",
      ],
      [
        {
          schema_version: 1,
          checks: [
            { id: "x", command: "bun" },
            { id: "x", command: "bun" },
          ],
        },
        "duplicate",
      ],
      [
        {
          schema_version: 1,
          checks: [{ id: "x", command: "bun" }],
          output_dir: "/tmp/out",
        },
        "output_dir",
      ],
      [
        {
          schema_version: 1,
          checks: [{ id: "x", command: "bun" }],
          output_dir: "../out",
        },
        "output_dir",
      ],
      [{ schema_version: 1, checks: ["nope"] }, "object"],
    ];
    for (const [input, fragment] of cases) {
      const result = parseConfig(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(fragment);
    }
  });
});

describe("loadConfig", () => {
  test("distinguishes absent, invalid JSON and declared", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evidence-config-"));
    expect(await loadConfig(dir)).toEqual({
      ok: true,
      value: { kind: "absent" },
    });
    writeFileSync(join(dir, ".evidence.json"), "{bad");
    const invalid = await loadConfig(dir);
    expect(invalid.ok).toBe(false);
    writeFileSync(join(dir, ".evidence.json"), JSON.stringify(valid));
    const declared = await loadConfig(dir);
    expect(declared.ok && declared.value.kind).toBe("declared");
  });
});
