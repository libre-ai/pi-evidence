// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { fail, ok, type Result } from "./result.ts";
import type { Signer } from "./signer.ts";

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
export function extractReportVerdict(text: string): ReportVerdict {
  const match = text.match(
    /verdict\s*:?\*{0,2}\s*:?\s*(PASS|FAIL|BLOCKED|SKIP)\b/i,
  );
  if (match === null) return "UNKNOWN";
  return (match[1] ?? "UNKNOWN").toUpperCase() as ReportVerdict;
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
  let bytes: Buffer;
  try {
    bytes = await readFile(options.file);
  } catch {
    return fail(`cannot read ${options.file}`);
  }
  const bundleDir = join(options.outputDir, options.id);
  const attachmentsDir = join(bundleDir, "attachments");
  await mkdir(attachmentsDir, { recursive: true });
  const name = basename(options.file);
  const target = join(attachmentsDir, name);
  await copyFile(options.file, target);
  const attachment: Attachment = {
    kind: options.kind,
    file: join(options.id, "attachments", name),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    attached_at: options.now.toISOString(),
    report_verdict: extractReportVerdict(bytes.toString("utf8")),
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
