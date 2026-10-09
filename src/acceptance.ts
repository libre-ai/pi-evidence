// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fail, ok, type Result } from "./result.ts";
import type { Signer } from "./signer.ts";
import { readStableFile } from "./stable-read.ts";

// Reports are text; the bound keeps an attachment from filling the evidence
// directory or memory with a file that was never a report.
export const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;

// Acceptance lives in a sidecar next to the run bundle: the run attestation
// stays immutable once signed, and a human decision is a separate signed act.
export const ACCEPTANCE_SUFFIX = ".acceptance.json";

export type ReportVerdict = "PASS" | "FAIL" | "BLOCKED" | "SKIP" | "UNKNOWN";

export interface Attachment {
  readonly kind: string;
  readonly file: string;
  readonly sha256: string;
  readonly attached_at: string;
  readonly report_verdict: ReportVerdict;
}

export interface AcceptanceDecision {
  readonly by: string;
  readonly decision: "accepted" | "rejected";
  readonly note: string;
  readonly decided_at: string;
  readonly signature: { readonly keyid: string; readonly sig: string } | null;
}

export interface AcceptanceRecord {
  readonly schema_version: 1;
  readonly bundle_id: string;
  readonly attachments: readonly Attachment[];
  readonly decisions: readonly AcceptanceDecision[];
}

const ATTACHMENT_KINDS = ["verify-runtime", "report"] as const;
const ID = /^[A-Za-z0-9-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function acceptanceFile(outputDir: string, id: string): string {
  return join(outputDir, `${id}${ACCEPTANCE_SUFFIX}`);
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function readAcceptance(
  outputDir: string,
  id: string,
): Promise<Result<AcceptanceRecord>> {
  if (!ID.test(id)) return fail("invalid bundle id");
  let text: string;
  try {
    text = await readFile(acceptanceFile(outputDir, id), "utf8");
  } catch {
    return ok({
      schema_version: 1,
      bundle_id: id,
      attachments: [],
      decisions: [],
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("acceptance record is not valid JSON");
  }
  if (
    !isRecord(raw) ||
    raw.schema_version !== 1 ||
    raw.bundle_id !== id ||
    !Array.isArray(raw.attachments) ||
    !Array.isArray(raw.decisions)
  ) {
    return fail("acceptance record malformed");
  }
  return ok(raw as unknown as AcceptanceRecord);
}

// The verdict line format is the one the governed runtime-verification skill
// produces (`**Verdict :** PASS`); a plain `Verdict: PASS` is accepted too.
// The report is untrusted text: a verdict counts only when it is the whole
// line, so prose quoting a verdict or the skill's unfilled template line
// (`PASS | FAIL | BLOCKED | SKIP`) is not read as one, and a report stating
// two different verdicts states none.
const VERDICT_LINE =
  /^\s*\**\s*verdict\s*\**\s*:?\s*\**\s*(PASS|FAIL|BLOCKED|SKIP)\s*\**\s*$/i;

export function extractReportVerdict(text: string): ReportVerdict {
  const verdicts = new Set<ReportVerdict>();
  for (const line of text.split(/\r?\n/)) {
    const match = VERDICT_LINE.exec(line);
    if (match?.[1] !== undefined) {
      verdicts.add(match[1].toUpperCase() as ReportVerdict);
    }
  }
  const [only] = verdicts;
  return verdicts.size === 1 && only !== undefined ? only : "UNKNOWN";
}

// The attachment is created once: linking a fully written temporary file
// fails if the name exists, so a second report with the same name can never
// replace content whose digest the record already holds.
async function storeOnce(target: string, bytes: Buffer): Promise<Result<void>> {
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await link(temporary, target);
    return ok(undefined);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return fail(`${basename(target)} is already attached to this bundle`);
    }
    return fail(`cannot store attachment ${basename(target)}`);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function attachReport(options: {
  readonly outputDir: string;
  readonly id: string;
  readonly kind: string;
  readonly file: string;
  readonly now: Date;
}): Promise<Result<Attachment>> {
  if (!(ATTACHMENT_KINDS as readonly string[]).includes(options.kind)) {
    return fail(`kind must be one of ${ATTACHMENT_KINDS.join(", ")}`);
  }
  const record = await readAcceptance(options.outputDir, options.id);
  if (!record.ok) return record;
  const read = await readStableFile(options.file, MAX_ATTACHMENT_BYTES);
  if (!read.ok) return read;
  const bundleDir = join(options.outputDir, options.id);
  const attachmentsDir = join(bundleDir, "attachments");
  await mkdir(attachmentsDir, { recursive: true });
  const name = basename(options.file);
  // The stored file is written from the bytes that were hashed, never copied
  // again from the source path, which may have changed since the read.
  const stored = await storeOnce(join(attachmentsDir, name), read.value.bytes);
  if (!stored.ok) return stored;
  const attachment: Attachment = {
    kind: options.kind,
    file: join(options.id, "attachments", name),
    sha256: read.value.sha256,
    attached_at: options.now.toISOString(),
    report_verdict: extractReportVerdict(read.value.bytes.toString("utf8")),
  };
  await writeAtomic(acceptanceFile(options.outputDir, options.id), {
    ...record.value,
    attachments: [...record.value.attachments, attachment],
  });
  return ok(attachment);
}

export async function recordDecision(options: {
  readonly outputDir: string;
  readonly id: string;
  readonly by: string;
  readonly decision: "accepted" | "rejected";
  readonly note: string;
  readonly now: Date;
  readonly signer: Signer | null;
}): Promise<Result<AcceptanceDecision>> {
  if (options.by.trim() === "")
    return fail("an acceptance needs a named person");
  const record = await readAcceptance(options.outputDir, options.id);
  if (!record.ok) return record;
  const unsigned = {
    bundle_id: options.id,
    by: options.by,
    decision: options.decision,
    note: options.note,
    decided_at: options.now.toISOString(),
  };
  let signature: AcceptanceDecision["signature"] = null;
  if (options.signer !== null) {
    const signed = await options.signer.sign(
      new TextEncoder().encode(JSON.stringify(unsigned)),
    );
    if (!signed.ok) return fail(`signature failed: ${signed.error}`);
    signature = { keyid: options.signer.keyid, sig: signed.value };
  }
  const decision: AcceptanceDecision = {
    by: options.by,
    decision: options.decision,
    note: options.note,
    decided_at: unsigned.decided_at,
    signature,
  };
  await mkdir(options.outputDir, { recursive: true });
  await writeAtomic(acceptanceFile(options.outputDir, options.id), {
    ...record.value,
    decisions: [...record.value.decisions, decision],
  });
  return ok(decision);
}

export function summarizeAcceptance(record: AcceptanceRecord): string[] {
  const lines: string[] = [];
  for (const attachment of record.attachments) {
    lines.push(
      `pièce jointe ${attachment.kind} : ${attachment.file} (${attachment.report_verdict}, ${attachment.sha256.slice(0, 12)})`,
    );
  }
  for (const decision of record.decisions) {
    lines.push(
      `acceptation ${decision.decision} par ${decision.by} le ${decision.decided_at}${decision.signature === null ? " (non signée)" : ` (signée ${decision.signature.keyid})`}${decision.note === "" ? "" : ` — ${decision.note}`}`,
    );
  }
  return lines;
}
