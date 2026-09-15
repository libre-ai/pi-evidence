// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runProcess } from "../src/exec.ts";
import { EvidenceService } from "../src/service.ts";
import { gitRepo } from "./binding.test.ts";

const session = {
  session_id: "s",
  provider: "p",
  model: "m",
  thinking_level: null,
};

describe("recipe gate in the service", () => {
  test("refuses an unaccepted recipe, accepts once, refuses again after a change", async () => {
    const dir = gitRepo();
    writeFileSync(
      join(dir, ".evidence.json"),
      JSON.stringify({
        schema_version: 1,
        checks: [
          { id: "t", command: "sh", args: ["-c", "true"], required: true },
        ],
      }),
    );
    const service = new EvidenceService({ exec: runProcess, repoRoot: dir });
    const refused = await service.run({ only: [], session });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("jamais acceptée");
    const pin = await service.pinStatus();
    expect(pin.ok && pin.value.state.state).toBe("unpinned");
    const accepted = await service.run({
      only: [],
      session,
      acceptRecipe: { by: "alice" },
      requirement: "REQ-1",
    });
    expect(accepted.ok && accepted.value.bundle.requirement).toBe("REQ-1");
    expect((await service.run({ only: [], session })).ok).toBe(true);
    writeFileSync(
      join(dir, ".evidence.json"),
      JSON.stringify({
        schema_version: 1,
        checks: [
          {
            id: "t",
            command: "sh",
            args: ["-c", "echo changed"],
            required: true,
          },
        ],
      }),
    );
    const changed = await service.run({ only: [], session });
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.error).toContain("alice");
    const manual = await service.acceptCurrentRecipe("bob");
    expect(manual.ok && manual.value).toContain("bob");
    expect((await service.run({ only: [], session })).ok).toBe(true);
    const status = await service.status();
    expect(status.ok && status.value.split("\n")).toHaveLength(3);
  });
});
