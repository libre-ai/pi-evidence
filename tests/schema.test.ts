// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { runProcess } from "../src/exec.ts";
import { EvidenceService } from "../src/service.ts";
import { gitRepo } from "./binding.test.ts";

describe("evidence schema", () => {
  test("a real bundle validates against docs/evidence.schema.json", async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(
      await Bun.file(
        join(import.meta.dir, "..", "docs", "evidence.schema.json"),
      ).json(),
    );
    const dir = gitRepo();
    writeFileSync(
      join(dir, ".evidence.json"),
      JSON.stringify({
        schema_version: 1,
        checks: [
          { id: "t", command: "sh", args: ["-c", "echo hi"], required: true },
        ],
      }),
    );
    const service = new EvidenceService({ exec: runProcess, repoRoot: dir });
    const run = await service.run({
      only: [],
      session: {
        session_id: "s",
        provider: "p",
        model: "m",
        thinking_level: null,
      },
      acceptRecipe: { by: "t" },
    });
    if (!run.ok) throw new Error(run.error);
    const stored = await Bun.file(run.value.file).json();
    expect(validate(stored), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...stored, verdict: "maybe" })).toBe(false);
  });
});
