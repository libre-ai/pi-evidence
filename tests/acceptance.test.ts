// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachReport,
  extractReportVerdict,
  readAcceptance,
  recordDecision,
  summarizeAcceptance,
} from "../src/acceptance.ts";
import { ok } from "../src/result.ts";

describe("acceptance sidecar", () => {
  test("extracts report verdicts", () => {
    expect(extractReportVerdict("**Verdict :** PASS\n")).toBe("PASS");
    expect(extractReportVerdict("Verdict: blocked")).toBe("BLOCKED");
    expect(extractReportVerdict("no verdict here")).toBe("UNKNOWN");
  });

  test("attaches a report and records a signed decision without touching the bundle", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "evidence-acc-")), ".evidence");
    const report = join(tmpdir(), `report-${Date.now()}.md`);
    writeFileSync(report, "## Vérification runtime\n\n**Verdict :** FAIL\n");
    const attached = await attachReport({
      outputDir: dir,
      id: "20260915T120000Z-abcdef0",
      kind: "verify-runtime",
      file: report,
      now: new Date("2026-09-15T13:00:00Z"),
    });
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(attached.value.report_verdict).toBe("FAIL");
    expect(
      existsSync(
        join(
          dir,
          "20260915T120000Z-abcdef0",
          "attachments",
          attached.value.file.split("/").pop() ?? "",
        ),
      ),
    ).toBe(true);
    const signer = { keyid: "SHA256:fake", sign: async () => ok("c2ln") };
    const decided = await recordDecision({
      outputDir: dir,
      id: "20260915T120000Z-abcdef0",
      by: "Alice",
      decision: "accepted",
      note: "ok for release",
      now: new Date("2026-09-15T14:00:00Z"),
      signer,
    });
    expect(decided.ok && decided.value.signature?.keyid).toBe("SHA256:fake");
    const unsigned = await recordDecision({
      outputDir: dir,
      id: "20260915T120000Z-abcdef0",
      by: "Bob",
      decision: "rejected",
      note: "",
      now: new Date(),
      signer: null,
    });
    expect(unsigned.ok && unsigned.value.signature).toBeNull();
    const record = await readAcceptance(dir, "20260915T120000Z-abcdef0");
    expect(record.ok && record.value.attachments).toHaveLength(1);
    expect(record.ok && record.value.decisions).toHaveLength(2);
    const lines = record.ok ? summarizeAcceptance(record.value) : [];
    expect(lines[0]).toContain("verify-runtime");
    expect(lines[1]).toContain("signée SHA256:fake");
    expect(lines[2]).toContain("non signée");
    expect(
      (
        await attachReport({
          outputDir: dir,
          id: "x",
          kind: "other",
          file: report,
          now: new Date(),
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await attachReport({
          outputDir: dir,
          id: "x",
          kind: "report",
          file: "/nonexistent/r.md",
          now: new Date(),
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await recordDecision({
          outputDir: dir,
          id: "x",
          by: " ",
          decision: "accepted",
          note: "",
          now: new Date(),
          signer: null,
        })
      ).ok,
    ).toBe(false);
    expect((await readAcceptance(dir, "../x")).ok).toBe(false);
    writeFileSync(join(dir, "bad.acceptance.json"), "{");
    expect((await readAcceptance(dir, "bad")).ok).toBe(false);
  });
});
