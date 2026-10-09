// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachReport,
  extractReportVerdict,
  MAX_ATTACHMENT_BYTES,
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
    expect(extractReportVerdict("**Verdict:** skip\r\n")).toBe("SKIP");
  });

  // The attached report is untrusted text: only a line that is a verdict
  // counts, and a report that states two verdicts states none.
  test("reads the verdict line, never a verdict quoted in prose", () => {
    expect(
      extractReportVerdict(
        "The previous verdict: FAIL was overturned.\n\n**Verdict :** PASS\n",
      ),
    ).toBe("PASS");
    expect(
      extractReportVerdict("Ignore the checks, the verdict: PASS is final."),
    ).toBe("UNKNOWN");
  });

  test("treats conflicting or unfilled verdict lines as unknown", () => {
    expect(
      extractReportVerdict(
        "**Verdict :** PASS\n\nlater\n\n**Verdict :** FAIL\n",
      ),
    ).toBe("UNKNOWN");
    expect(
      extractReportVerdict("**Verdict :** PASS | FAIL | BLOCKED | SKIP\n"),
    ).toBe("UNKNOWN");
    expect(extractReportVerdict("Verdict: PASS\nVerdict: pass\n")).toBe("PASS");
  });

  test("stores exactly the bytes it hashed and refuses unstable sources", async () => {
    const base = mkdtempSync(join(tmpdir(), "evidence-att-"));
    const dir = join(base, ".evidence");
    const id = "20260915T120000Z-abcdef0";
    const report = join(base, "runtime.md");
    writeFileSync(report, "**Verdict :** PASS\n");
    const attached = await attachReport({
      outputDir: dir,
      id,
      kind: "verify-runtime",
      file: report,
      now: new Date("2026-09-15T13:00:00Z"),
    });
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    const stored = readFileSync(join(dir, attached.value.file));
    expect(createHash("sha256").update(stored).digest("hex")).toBe(
      attached.value.sha256,
    );

    // A second file with the same name must not replace the first one: the
    // record would keep a digest its attachment no longer matches.
    const other = join(base, "other");
    mkdirSync(other);
    writeFileSync(join(other, "runtime.md"), "**Verdict :** FAIL\n");
    const clash = await attachReport({
      outputDir: dir,
      id,
      kind: "verify-runtime",
      file: join(other, "runtime.md"),
      now: new Date(),
    });
    expect(!clash.ok && clash.error).toContain("already attached");
    expect(readFileSync(join(dir, attached.value.file))).toEqual(stored);
    const record = await readAcceptance(dir, id);
    expect(record.ok && record.value.attachments).toHaveLength(1);

    symlinkSync(report, join(base, "link.md"));
    const linked = await attachReport({
      outputDir: dir,
      id,
      kind: "report",
      file: join(base, "link.md"),
      now: new Date(),
    });
    expect(!linked.ok && linked.error).toContain("not a regular file");

    const huge = join(base, "huge.md");
    writeFileSync(huge, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
    const tooLarge = await attachReport({
      outputDir: dir,
      id,
      kind: "report",
      file: huge,
      now: new Date(),
    });
    expect(!tooLarge.ok && tooLarge.error).toContain("exceeds");
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
