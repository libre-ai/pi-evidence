// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attestationFiles,
  buildStatement,
  canonicalize,
  type DsseEnvelope,
  dssePreAuthenticationEncoding,
  envelopeFor,
  type InTotoStatement,
  PAYLOAD_TYPE,
  PREDICATE_TYPE,
  parseEnvelope,
  statementFromEnvelope,
  verifyAttestation,
  writeAttestation,
} from "../src/attestation.ts";
import type { EvidenceBundle } from "../src/bundle.ts";
import { runProcess } from "../src/exec.ts";
import {
  createSshSigner,
  createSshVerifier,
  type Signer,
  type Verifier,
} from "../src/signer.ts";

const sampleBundle = (id = "20260915T120000Z-abcdef0"): EvidenceBundle => ({
  schema_version: 2,
  id,
  created_at: "2026-09-15T12:00:00.000Z",
  repository_root: "/repo",
  revision: {
    head: "abcdef0123456789abcdef0123456789abcdef01",
    branch: "main",
    dirty: false,
    changed_files: [],
    status_sha256: "0".repeat(64),
    diff_sha256: "1".repeat(64),
  },
  recipe: {
    origin: "declared",
    hash: "2".repeat(64),
    checks: [
      {
        id: "t",
        command: "sh",
        args: ["-c", "true"],
        required: true,
        timeout_seconds: 600,
      },
    ],
    selected: ["t"],
  },
  results: [],
  verdict: "conformant",
  reasons: ["all required checks passed"],
  criteria_declared: true,
  requirement: null,
  environment: {
    platform: "darwin",
    arch: "arm64",
    lockfiles: {},
    node_modules_present: false,
    fingerprint_sha256: "3".repeat(64),
  },
  differential: null,
  session: { session_id: "s", provider: "p", model: "m", thinking_level: null },
  tools: { bun: "1.4.0", node: "v26.8.2", cargo: null },
});

const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf8");

const encodePayload = (statement: InTotoStatement): string =>
  Buffer.from(JSON.stringify(statement)).toString("base64");

describe("attestation: statement and envelope", () => {
  test("PAE bytes for a known small input", () => {
    const pae = dssePreAuthenticationEncoding(
      PAYLOAD_TYPE,
      new TextEncoder().encode("hello"),
    );
    expect(text(pae)).toBe("DSSEv1 28 application/vnd.in-toto+json 5 hello");
    // Lengths count bytes, not characters: a multi-byte payload must not be
    // measured by its string length.
    const accented = dssePreAuthenticationEncoding(
      "t",
      new TextEncoder().encode("é"),
    );
    expect(text(accented)).toBe("DSSEv1 1 t 2 é");
  });

  test("subject binds HEAD and tree fingerprints", () => {
    const statement = buildStatement(sampleBundle());
    expect(statement._type).toBe("https://in-toto.io/Statement/v1");
    expect(statement.predicateType).toBe(PREDICATE_TYPE);
    expect(statement.subject).toEqual([
      {
        name: "git:abcdef0123456789abcdef0123456789abcdef01",
        digest: {
          sha1: "abcdef0123456789abcdef0123456789abcdef01",
          "tree-diff-sha256": "1".repeat(64),
          "tree-status-sha256": "0".repeat(64),
        },
      },
    ]);
    expect(statement.predicate).toEqual(sampleBundle());
  });

  test("canonicalization is stable across key order and free of whitespace", () => {
    const a = buildStatement(sampleBundle());
    const reordered = JSON.parse(
      JSON.stringify({
        predicate: { ...a.predicate, session: { ...a.predicate.session } },
        predicateType: a.predicateType,
        subject: a.subject.map((s) => ({ digest: s.digest, name: s.name })),
        _type: a._type,
      }),
    ) as InTotoStatement;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(a));
    const bytes = canonicalize(a);
    expect(bytes).toEqual(canonicalize(reordered));
    const json = text(bytes);
    expect(
      json.startsWith(
        '{"_type":"https://in-toto.io/Statement/v1","predicate":{',
      ),
    ).toBe(true);
    expect(json).not.toContain("\n");
    expect(json).not.toContain(": ");
    // Arrays keep their order: reordering array items is a different value.
    expect(JSON.parse(json)).toEqual(a);
    expect(
      canonicalize({ ...a, subject: [...a.subject, ...a.subject] }),
    ).not.toEqual(bytes);
    // Explicit undefined members are dropped exactly like JSON.stringify does.
    expect(
      text(canonicalize({ ...a, extra: undefined } as InTotoStatement)),
    ).toBe(json);
  });

  test("envelope round-trips and malformed envelopes are refused", () => {
    const statement = buildStatement(sampleBundle());
    const envelope = envelopeFor(statement, [{ keyid: "k", sig: "c2ln" }]);
    expect(envelope.payloadType).toBe(PAYLOAD_TYPE);
    expect(Buffer.from(envelope.payload, "base64")).toEqual(
      Buffer.from(canonicalize(statement)),
    );
    expect(statementFromEnvelope(envelope)).toEqual({
      ok: true,
      value: statement,
    });
    expect(statementFromEnvelope(JSON.parse(JSON.stringify(envelope)))).toEqual(
      {
        ok: true,
        value: statement,
      },
    );

    const refused = (value: unknown): string => {
      const result = statementFromEnvelope(value);
      expect(result.ok).toBe(false);
      return result.ok ? "" : result.error;
    };
    expect(refused(null)).toContain("payloadType");
    expect(refused("text")).toContain("payloadType");
    expect(refused({ ...envelope, payloadType: "text/plain" })).toContain(
      "payloadType",
    );
    expect(refused({ ...envelope, payload: 12 })).toContain("base64");
    expect(refused({ ...envelope, payload: "not base64!" })).toContain(
      "base64",
    );
    expect(refused({ ...envelope, payload: "abc" })).toContain("base64");
    expect(refused({ ...envelope, signatures: [] })).toContain("signatures");
    expect(refused({ ...envelope, signatures: "x" })).toContain("signatures");
    expect(
      refused({ ...envelope, signatures: [{ keyid: 1, sig: "c2ln" }] }),
    ).toContain("signatures");
    expect(
      refused({ ...envelope, signatures: [{ keyid: "k", sig: "###" }] }),
    ).toContain("signatures");
    expect(
      refused({ ...envelope, payload: Buffer.from("{").toString("base64") }),
    ).toContain("not JSON");
    expect(
      refused({ ...envelope, payload: Buffer.from('"s"').toString("base64") }),
    ).toContain("_type");
    expect(
      refused({
        ...envelope,
        payload: encodePayload({ ...statement, subject: [] }),
      }),
    ).toContain("subject");
    expect(
      refused({
        ...envelope,
        payload: encodePayload({
          ...statement,
          subject: [{ name: "x", digest: { sha1: 1 as unknown as string } }],
        }),
      }),
    ).toContain("subject");
    expect(
      refused({
        ...envelope,
        payload: encodePayload({
          ...statement,
          predicateType: 3 as unknown as string,
        }),
      }),
    ).toContain("predicateType");
    expect(
      refused({
        ...envelope,
        payload: encodePayload({
          ...statement,
          predicate: { ...statement.predicate, verdict: "maybe" as "failed" },
        }),
      }),
    ).toContain("predicate");
    expect(parseEnvelope(envelope).ok).toBe(true);
  });

  test("file names live under the output directory", () => {
    expect(attestationFiles("/out/.evidence", "id-1")).toEqual({
      statement: "/out/.evidence/id-1.intoto.json",
      envelope: "/out/.evidence/id-1.dsse.json",
    });
  });
});

describe("attestation: unsigned", () => {
  test("writes the statement only and verification reports it unsigned", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "evidence-att-")), ".evidence");
    const bundle = sampleBundle();
    const written = await writeAttestation(dir, bundle, null);
    expect(written).toEqual({
      ok: true,
      value: {
        statement: join(dir, `${bundle.id}.intoto.json`),
        envelope: null,
        keyid: null,
      },
    });
    expect(readdirSync(dir).sort()).toEqual([`${bundle.id}.intoto.json`]);
    const onDisk = JSON.parse(
      readFileSync(join(dir, `${bundle.id}.intoto.json`), "utf8"),
    );
    expect(onDisk).toEqual(buildStatement(bundle));
    expect(await verifyAttestation(dir, bundle.id, null)).toEqual({
      ok: true,
      value: {
        signed: false,
        valid: null,
        keyid: null,
        statement: buildStatement(bundle),
      },
    });
    const missing = await verifyAttestation(dir, "nope", null);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("not found");
    writeFileSync(join(dir, "broken.intoto.json"), "{");
    expect((await verifyAttestation(dir, "broken", null)).ok).toBe(false);
    writeFileSync(join(dir, "shape.intoto.json"), '{"_type":"x"}');
    expect((await verifyAttestation(dir, "shape", null)).ok).toBe(false);
  });

  test("a signer that fails leaves nothing on disk", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "evidence-att-")), ".evidence");
    const failing: Signer = {
      keyid: "SHA256:none",
      sign: async () => ({ ok: false, error: "ssh-keygen is not installed" }),
    };
    const written = await writeAttestation(dir, sampleBundle(), failing);
    expect(written).toEqual({
      ok: false,
      error: "attestation: signing failed: ssh-keygen is not installed",
    });
    // Signing precedes any write: not even the output directory appears.
    expect(existsSync(dir)).toBe(false);
  }, 10_000);

  test("an unwritable output directory is reported, not thrown", async () => {
    const parent = mkdtempSync(join(tmpdir(), "evidence-att-"));
    writeFileSync(join(parent, "file"), "");
    const written = await writeAttestation(
      join(parent, "file"),
      sampleBundle(),
      null,
    );
    expect(written.ok).toBe(false);
    if (!written.ok) expect(written.error).toContain("write failed");
  });
});

describe("attestation: signed with an ephemeral SSH key", () => {
  let keyDir: string;
  let keyPath: string;
  let allowedSigners: string;
  let otherSigners: string;

  beforeAll(async () => {
    keyDir = mkdtempSync(join(tmpdir(), "evidence-keys-"));
    keyPath = join(keyDir, "key");
    const generate = await runProcess("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      "evidence-test",
      "-f",
      keyPath,
    ]);
    expect(generate.ok && generate.value.code).toBe(0);
    const other = await runProcess("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      "",
      "-f",
      join(keyDir, "other"),
    ]);
    expect(other.ok && other.value.code).toBe(0);
    allowedSigners = join(keyDir, "allowed_signers");
    writeFileSync(
      allowedSigners,
      `tester@example namespaces="evidence" ${readFileSync(`${keyPath}.pub`, "utf8")}`,
    );
    otherSigners = join(keyDir, "other_signers");
    writeFileSync(
      otherSigners,
      `other@example ${readFileSync(join(keyDir, "other.pub"), "utf8")}`,
    );
  });

  const signer = async (): Promise<Signer> => {
    const created = await createSshSigner(runProcess, { keyPath });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error);
    return created.value;
  };
  const verifier = (): Verifier =>
    createSshVerifier(runProcess, { allowedSignersFile: allowedSigners });

  test("writes statement and envelope, verifies, and detects tampering", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "evidence-att-")), ".evidence");
    const bundle = sampleBundle();
    const s = await signer();
    const written = await writeAttestation(dir, bundle, s);
    expect(written).toEqual({
      ok: true,
      value: {
        statement: join(dir, `${bundle.id}.intoto.json`),
        envelope: join(dir, `${bundle.id}.dsse.json`),
        keyid: s.keyid,
      },
    });
    expect(s.keyid.startsWith("SHA256:")).toBe(true);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    const envelopeFile = join(dir, `${bundle.id}.dsse.json`);
    const envelope = JSON.parse(
      readFileSync(envelopeFile, "utf8"),
    ) as DsseEnvelope;
    expect(envelope.signatures).toHaveLength(1);
    expect(envelope.signatures[0]?.keyid).toBe(s.keyid);
    expect(
      Buffer.from(envelope.signatures[0]?.sig ?? "", "base64").toString("utf8"),
    ).toStartWith("-----BEGIN SSH SIGNATURE-----");
    // The tmp folder must not keep the signed message around.
    expect(
      readdirSync(tmpdir()).filter((f) => f.startsWith("evidence-sign-")),
    ).toEqual([]);

    const valid = await verifyAttestation(dir, bundle.id, verifier());
    expect(valid).toEqual({
      ok: true,
      value: {
        signed: true,
        valid: true,
        keyid: s.keyid,
        statement: buildStatement(bundle),
      },
    });
    expect(
      readdirSync(tmpdir()).filter((f) => f.startsWith("evidence-verify-")),
    ).toEqual([]);

    // No verifier: signed is known, validity is not claimed.
    expect(await verifyAttestation(dir, bundle.id, null)).toEqual({
      ok: true,
      value: {
        signed: true,
        valid: null,
        keyid: s.keyid,
        statement: buildStatement(bundle),
      },
    });

    // Key not in the allowed signers: false, not an error.
    const stranger = createSshVerifier(runProcess, {
      allowedSignersFile: otherSigners,
    });
    expect((await verifyAttestation(dir, bundle.id, stranger)).ok && true).toBe(
      true,
    );
    const strangerResult = await verifyAttestation(dir, bundle.id, stranger);
    expect(strangerResult.ok && strangerResult.value.valid).toBe(false);

    // Tampered payload (still a well-formed statement): signature no longer
    // covers it.
    const tampered: DsseEnvelope = {
      ...envelope,
      payload: encodePayload({
        ...buildStatement(bundle),
        predicate: { ...bundle, verdict: "failed" },
      }),
    };
    writeFileSync(envelopeFile, JSON.stringify(tampered));
    const afterTamper = await verifyAttestation(dir, bundle.id, verifier());
    expect(afterTamper.ok && afterTamper.value.valid).toBe(false);

    // A genuine envelope for another statement does not authenticate this
    // statement file, even though its signature is good.
    const otherDir = join(
      mkdtempSync(join(tmpdir(), "evidence-att-")),
      ".evidence",
    );
    const otherBundle = sampleBundle("20260915T130000Z-abcdef0");
    const otherWritten = await writeAttestation(otherDir, otherBundle, s);
    expect(otherWritten.ok).toBe(true);
    writeFileSync(
      envelopeFile,
      readFileSync(join(otherDir, `${otherBundle.id}.dsse.json`)),
    );
    const swapped = await verifyAttestation(dir, bundle.id, verifier());
    expect(swapped.ok && swapped.value.valid).toBe(false);
    expect(swapped.ok && swapped.value.signed).toBe(true);

    // Envelope whose keyid does not name the verifying key is refused.
    const renamed: DsseEnvelope = {
      ...envelope,
      signatures: [
        { keyid: "SHA256:someoneelse", sig: envelope.signatures[0]?.sig ?? "" },
      ],
    };
    writeFileSync(envelopeFile, JSON.stringify(renamed));
    const wrongKeyid = await verifyAttestation(dir, bundle.id, verifier());
    expect(wrongKeyid.ok && wrongKeyid.value.valid).toBe(false);

    // Malformed envelopes are refused outright.
    writeFileSync(envelopeFile, "{");
    expect((await verifyAttestation(dir, bundle.id, verifier())).ok).toBe(
      false,
    );
    writeFileSync(
      envelopeFile,
      JSON.stringify({ ...envelope, signatures: [] }),
    );
    expect((await verifyAttestation(dir, bundle.id, verifier())).ok).toBe(
      false,
    );
    writeFileSync(
      envelopeFile,
      JSON.stringify({
        ...envelope,
        payload: Buffer.from("[]").toString("base64"),
      }),
    );
    expect((await verifyAttestation(dir, bundle.id, verifier())).ok).toBe(
      false,
    );

    // Tooling failure inside the verifier surfaces as an error, not a false.
    writeFileSync(envelopeFile, JSON.stringify(envelope));
    const broken: Verifier = {
      verify: async () => ({ ok: false, error: "ssh-keygen is not installed" }),
    };
    expect(await verifyAttestation(dir, bundle.id, broken)).toEqual({
      ok: false,
      error: "attestation: verification: ssh-keygen is not installed",
    });
  }, 30_000);
});
