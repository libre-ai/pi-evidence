// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type EvidenceBundle, parseBundle } from "./bundle.ts";
import { fail, ok, type Result } from "./result.ts";
import type { Signer, Verifier } from "./signer.ts";

export interface InTotoStatement {
  readonly _type: "https://in-toto.io/Statement/v1";
  readonly subject: readonly {
    readonly name: string;
    readonly digest: Readonly<Record<string, string>>;
  }[];
  readonly predicateType: string;
  readonly predicate: EvidenceBundle;
}

export const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";

// Placeholder namespace: the public home of the predicate schema is an owner
// decision (plan 2, out of scope). Verifiers must pin the exact string, so it
// must change once, deliberately, not drift.
export const PREDICATE_TYPE =
  "https://libre-ai.example/attestation/evidence/v1";

export const PAYLOAD_TYPE = "application/vnd.in-toto+json";

export interface DsseEnvelope {
  readonly payloadType: "application/vnd.in-toto+json";
  // Base64 of the canonical statement bytes.
  readonly payload: string;
  readonly signatures: readonly {
    readonly keyid: string;
    readonly sig: string;
  }[];
}

// The subject is the revision the evidence was produced on: HEAD plus the
// fingerprints of what differed from it, so a dirty tree cannot pass for the
// commit alone.
export function buildStatement(bundle: EvidenceBundle): InTotoStatement {
  return {
    _type: STATEMENT_TYPE,
    subject: [
      {
        name: `git:${bundle.revision.head}`,
        digest: {
          sha1: bundle.revision.head,
          "tree-diff-sha256": bundle.revision.diff_sha256,
          "tree-status-sha256": bundle.revision.status_sha256,
        },
      },
    ],
    predicateType: PREDICATE_TYPE,
    predicate: bundle,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    // JSON.stringify drops functions and undefined; the statement types
    // exclude both, so a `undefined` here is a programming error, not data.
    const text = JSON.stringify(value);
    if (text === undefined) {
      throw new TypeError("canonicalize: value is not JSON-representable");
    }
    return text;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${members.join(",")}}`;
}

// Signatures cover bytes: the same statement must always serialize to the
// same bytes, whatever key order the producer used.
export function canonicalize(statement: InTotoStatement): Uint8Array {
  return new TextEncoder().encode(canonicalJson(statement));
}

// DSSE pre-authentication encoding: binds the payload type to the signed
// bytes so a signature over one content type cannot be replayed as another.
export function dssePreAuthenticationEncoding(
  payloadType: string,
  payload: Uint8Array,
): Uint8Array {
  const encoder = new TextEncoder();
  const typeBytes = encoder.encode(payloadType);
  const prefix = encoder.encode(`DSSEv1 ${typeBytes.length} `);
  const middle = encoder.encode(` ${payload.length} `);
  const out = new Uint8Array(
    prefix.length + typeBytes.length + middle.length + payload.length,
  );
  out.set(prefix, 0);
  out.set(typeBytes, prefix.length);
  out.set(middle, prefix.length + typeBytes.length);
  out.set(payload, prefix.length + typeBytes.length + middle.length);
  return out;
}

export function envelopeFor(
  statement: InTotoStatement,
  signatures: readonly { keyid: string; sig: string }[],
): DsseEnvelope {
  return {
    payloadType: PAYLOAD_TYPE,
    payload: Buffer.from(canonicalize(statement)).toString("base64"),
    signatures: signatures.map(({ keyid, sig }) => ({ keyid, sig })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDigest(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

export function parseStatement(value: unknown): Result<InTotoStatement> {
  if (!isRecord(value) || value._type !== STATEMENT_TYPE)
    return fail(`statement: expected _type ${STATEMENT_TYPE}`);
  if (
    !Array.isArray(value.subject) ||
    value.subject.length === 0 ||
    !value.subject.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.name === "string" &&
        isDigest(entry.digest),
    )
  ) {
    return fail("statement: malformed subject");
  }
  if (typeof value.predicateType !== "string")
    return fail("statement: missing predicateType");
  const predicate = parseBundle(value.predicate);
  if (!predicate.ok) return fail(`statement predicate: ${predicate.error}`);
  return ok(value as unknown as InTotoStatement);
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

// Strict decoding: Buffer.from silently tolerates garbage, and a verifier
// must not "succeed" on bytes that were never the producer's.
function decodeBase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0 || !BASE64.test(text)) return null;
  return new Uint8Array(Buffer.from(text, "base64"));
}

export function parseEnvelope(value: unknown): Result<DsseEnvelope> {
  if (!isRecord(value) || value.payloadType !== PAYLOAD_TYPE)
    return fail(`envelope: expected payloadType ${PAYLOAD_TYPE}`);
  if (typeof value.payload !== "string" || decodeBase64(value.payload) === null)
    return fail("envelope: payload is not base64");
  if (
    !Array.isArray(value.signatures) ||
    value.signatures.length === 0 ||
    !value.signatures.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.keyid === "string" &&
        typeof entry.sig === "string" &&
        decodeBase64(entry.sig) !== null,
    )
  ) {
    return fail("envelope: malformed signatures");
  }
  return ok(value as unknown as DsseEnvelope);
}

export function statementFromEnvelope(
  envelope: unknown,
): Result<InTotoStatement> {
  const parsed = parseEnvelope(envelope);
  if (!parsed.ok) return parsed;
  const payload = Buffer.from(parsed.value.payload, "base64").toString("utf8");
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    return fail("envelope: payload is not JSON");
  }
  return parseStatement(decoded);
}

export function attestationFiles(
  outputDir: string,
  id: string,
): { statement: string; envelope: string } {
  return {
    statement: join(outputDir, `${id}.intoto.json`),
    envelope: join(outputDir, `${id}.dsse.json`),
  };
}

// Same discipline as writeBundle: an interrupted write never leaves a
// truncated file that a verifier could mistake for an attestation.
async function writeAtomically(target: string, text: string): Promise<void> {
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, text, "utf8");
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function writeAttestation(
  outputDir: string,
  bundle: EvidenceBundle,
  signer: Signer | null,
): Promise<
  Result<{ statement: string; envelope: string | null; keyid: string | null }>
> {
  const statement = buildStatement(bundle);
  const files = attestationFiles(outputDir, bundle.id);
  let envelope: DsseEnvelope | null = null;
  if (signer !== null) {
    const payload = canonicalize(statement);
    const signed = await signer.sign(
      dssePreAuthenticationEncoding(PAYLOAD_TYPE, payload),
    );
    if (!signed.ok) return fail(`attestation: signing failed: ${signed.error}`);
    envelope = envelopeFor(statement, [
      { keyid: signer.keyid, sig: signed.value },
    ]);
  }
  try {
    await mkdir(outputDir, { recursive: true });
    await writeAtomically(
      files.statement,
      `${JSON.stringify(statement, null, 2)}\n`,
    );
    if (envelope !== null) {
      await writeAtomically(
        files.envelope,
        `${JSON.stringify(envelope, null, 2)}\n`,
      );
    }
  } catch (error) {
    return fail(
      `attestation: write failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return ok({
    statement: files.statement,
    envelope: envelope === null ? null : files.envelope,
    keyid: signer === null ? null : signer.keyid,
  });
}

async function readJson(file: string): Promise<Result<unknown> | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return null;
  }
  try {
    return ok(JSON.parse(text));
  } catch {
    return fail(`not valid JSON: ${basename(file)}`);
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

// `valid` answers one question: does the envelope authenticate the statement
// file on disk? A good signature over some other payload is `false`, not a
// partial success. `null` means the question could not be asked (unsigned,
// or no verifier configured), which the caller must report as such.
export async function verifyAttestation(
  outputDir: string,
  id: string,
  verifier: Verifier | null,
): Promise<
  Result<{
    signed: boolean;
    valid: boolean | null;
    keyid: string | null;
    statement: InTotoStatement;
  }>
> {
  const files = attestationFiles(outputDir, id);
  const statementJson = await readJson(files.statement);
  if (statementJson === null)
    return fail(`attestation not found: ${basename(files.statement)}`);
  if (!statementJson.ok) return fail(`attestation: ${statementJson.error}`);
  const statement = parseStatement(statementJson.value);
  if (!statement.ok) return statement;

  const envelopeJson = await readJson(files.envelope);
  if (envelopeJson === null) {
    return ok({
      signed: false,
      valid: null,
      keyid: null,
      statement: statement.value,
    });
  }
  if (!envelopeJson.ok) return fail(`attestation: ${envelopeJson.error}`);
  const envelope = parseEnvelope(envelopeJson.value);
  if (!envelope.ok) return envelope;
  const signed = statementFromEnvelope(envelope.value);
  if (!signed.ok) return signed;
  const keyid = envelope.value.signatures[0]?.keyid ?? null;
  if (verifier === null) {
    return ok({ signed: true, valid: null, keyid, statement: statement.value });
  }

  const payload = new Uint8Array(Buffer.from(envelope.value.payload, "base64"));
  const pae = dssePreAuthenticationEncoding(
    envelope.value.payloadType,
    payload,
  );
  let valid = sameBytes(payload, canonicalize(statement.value));
  for (const signature of envelope.value.signatures) {
    if (!valid) break;
    const checked = await verifier.verify(pae, signature.keyid, signature.sig);
    if (!checked.ok) return fail(`attestation: verification: ${checked.error}`);
    valid = checked.value;
  }
  return ok({ signed: true, valid, keyid, statement: statement.value });
}
