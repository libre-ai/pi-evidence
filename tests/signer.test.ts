// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExecFn, type ProcessOutput, runProcess } from "../src/exec.ts";
import { ok } from "../src/result.ts";
import {
  createSshSigner,
  createSshVerifier,
  gitConfigReader,
  resolveSigningKey,
} from "../src/signer.ts";

const output = (code: number, stdout = "", stderr = ""): ProcessOutput => ({
  code,
  stdout,
  stderr,
  durationMs: 1,
});

// An ExecFn scripted per command: the first matching entry answers, and the
// calls are recorded so a test can assert the exact argv (never a shell).
const scripted = (
  script: readonly {
    command: string;
    reply: Awaited<ReturnType<ExecFn>>;
  }[],
): {
  exec: ExecFn;
  calls: { command: string; args: readonly string[] }[];
  stdins: (Uint8Array | undefined)[];
} => {
  const calls: { command: string; args: readonly string[] }[] = [];
  const stdins: (Uint8Array | undefined)[] = [];
  const remaining = [...script];
  const exec: ExecFn = async (command, args, options) => {
    calls.push({ command, args });
    stdins.push(options?.stdin);
    const index = remaining.findIndex((entry) => entry.command === command);
    if (index === -1) throw new Error(`unexpected command ${command}`);
    const [entry] = remaining.splice(index, 1);
    if (entry === undefined) throw new Error("unreachable");
    return entry.reply;
  };
  return { exec, calls, stdins };
};

describe("ssh signer with an ephemeral key", () => {
  let keyDir: string;
  let keyPath: string;
  let allowedSigners: string;

  beforeAll(async () => {
    keyDir = mkdtempSync(join(tmpdir(), "evidence-signer-"));
    keyPath = join(keyDir, "key");
    const generate = await runProcess("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      "",
      "-f",
      keyPath,
    ]);
    expect(generate.ok && generate.value.code).toBe(0);
    allowedSigners = join(keyDir, "allowed_signers");
    writeFileSync(
      allowedSigners,
      `alice@example ${readFileSync(`${keyPath}.pub`, "utf8")}`,
    );
  });

  test("keyid is the SHA256 fingerprint of the public key", async () => {
    const created = await createSshSigner(runProcess, { keyPath });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.keyid).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    const listed = await runProcess("ssh-keygen", ["-lf", `${keyPath}.pub`]);
    expect(listed.ok && listed.value.stdout).toContain(created.value.keyid);
  });

  test("signs bytes and the verifier accepts them, rejects altered bytes", async () => {
    const created = await createSshSigner(runProcess, { keyPath });
    if (!created.ok) throw new Error(created.error);
    const bytes = new TextEncoder().encode("DSSEv1 1 t 5 hello");
    const signed = await created.value.sign(bytes);
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    const armored = Buffer.from(signed.value, "base64").toString("utf8");
    expect(armored).toStartWith("-----BEGIN SSH SIGNATURE-----\n");
    expect(armored.trimEnd()).toEndWith("-----END SSH SIGNATURE-----");

    const verifier = createSshVerifier(runProcess, {
      allowedSignersFile: allowedSigners,
    });
    expect(
      await verifier.verify(bytes, created.value.keyid, signed.value),
    ).toEqual(ok(true));
    const altered = new TextEncoder().encode("DSSEv1 1 t 5 hellp");
    expect(
      await verifier.verify(altered, created.value.keyid, signed.value),
    ).toEqual(ok(false));
    // Another namespace is a different signing context: not valid.
    const otherNamespace = createSshVerifier(runProcess, {
      allowedSignersFile: allowedSigners,
      namespace: "other",
    });
    expect(
      await otherNamespace.verify(bytes, created.value.keyid, signed.value),
    ).toEqual(ok(false));
    // A keyid that does not match the verifying key is not accepted.
    expect(
      await verifier.verify(bytes, "SHA256:notthiskey", signed.value),
    ).toEqual(ok(false));
    // Garbage in place of a signature is a false, not a tooling failure.
    expect(
      await verifier.verify(
        bytes,
        created.value.keyid,
        Buffer.from("garbage").toString("base64"),
      ),
    ).toEqual(ok(false));
  }, 30_000);

  test("a custom namespace is honoured on both sides", async () => {
    const created = await createSshSigner(runProcess, {
      keyPath,
      namespace: "custom",
    });
    if (!created.ok) throw new Error(created.error);
    const bytes = new TextEncoder().encode("payload");
    const signed = await created.value.sign(bytes);
    if (!signed.ok) throw new Error(signed.error);
    const custom = createSshVerifier(runProcess, {
      allowedSignersFile: allowedSigners,
      namespace: "custom",
    });
    expect(
      await custom.verify(bytes, created.value.keyid, signed.value),
    ).toEqual(ok(true));
    const defaultNamespace = createSshVerifier(runProcess, {
      allowedSignersFile: allowedSigners,
    });
    expect(
      await defaultNamespace.verify(bytes, created.value.keyid, signed.value),
    ).toEqual(ok(false));
  }, 30_000);

  test("missing key, missing public key and missing signers are clear failures", async () => {
    const missing = await createSshSigner(runProcess, {
      keyPath: join(keyDir, "absent"),
    });
    expect(missing).toEqual({
      ok: false,
      error: `signing key not found: ${join(keyDir, "absent")}`,
    });
    const privateOnly = join(keyDir, "private-only");
    writeFileSync(privateOnly, "not a key");
    expect(await createSshSigner(runProcess, { keyPath: privateOnly })).toEqual(
      {
        ok: false,
        error: `public key not found next to the signing key: ${privateOnly}.pub`,
      },
    );
    writeFileSync(`${privateOnly}.pub`, "not a public key");
    const unreadable = await createSshSigner(runProcess, {
      keyPath: privateOnly,
    });
    expect(unreadable.ok).toBe(false);
    if (!unreadable.ok)
      expect(unreadable.error).toContain("ssh-keygen could not read");

    const verifier = createSshVerifier(runProcess, {
      allowedSignersFile: join(keyDir, "no_signers"),
    });
    expect(await verifier.verify(new Uint8Array(), "k", "c2ln")).toEqual({
      ok: false,
      error: `allowed signers file not found: ${join(keyDir, "no_signers")}`,
    });
  });
});

describe("ssh signer with a scripted exec", () => {
  let keyDir: string;
  let keyPath: string;
  let signers: string;

  beforeAll(() => {
    keyDir = mkdtempSync(join(tmpdir(), "evidence-signer-fake-"));
    keyPath = join(keyDir, "key");
    writeFileSync(keyPath, "private");
    writeFileSync(`${keyPath}.pub`, "public");
    signers = join(keyDir, "allowed_signers");
    writeFileSync(signers, "alice public");
  });

  test("tooling failures while reading the fingerprint", async () => {
    const notInstalled = scripted([
      { command: "ssh-keygen", reply: { ok: false, error: "spawn-failed" } },
    ]);
    expect(await createSshSigner(notInstalled.exec, { keyPath })).toEqual({
      ok: false,
      error: "ssh-keygen is not installed",
    });
    expect(notInstalled.calls).toEqual([
      { command: "ssh-keygen", args: ["-lf", `${keyPath}.pub`] },
    ]);
    const timedOut = scripted([
      { command: "ssh-keygen", reply: { ok: false, error: "timeout" } },
    ]);
    expect(await createSshSigner(timedOut.exec, { keyPath })).toEqual({
      ok: false,
      error: "ssh-keygen timeout",
    });
    const noFingerprint = scripted([
      { command: "ssh-keygen", reply: ok(output(0, "256 MD5:aa:bb (RSA)\n")) },
    ]);
    const result = await createSshSigner(noFingerprint.exec, { keyPath });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("no SHA256 fingerprint");
  });

  test("sign reports a failing or silent ssh-keygen", async () => {
    const listing = ok(output(0, "256 SHA256:abc comment (ED25519)\n"));
    const failing = scripted([
      { command: "ssh-keygen", reply: listing },
      { command: "ssh-keygen", reply: ok(output(255, "", "bad key")) },
    ]);
    const signer = await createSshSigner(failing.exec, { keyPath });
    if (!signer.ok) throw new Error(signer.error);
    expect(signer.value.keyid).toBe("SHA256:abc");
    expect(await signer.value.sign(new Uint8Array([1]))).toEqual({
      ok: false,
      error: "ssh-keygen sign failed: bad key",
    });
    const signCall = failing.calls[1];
    expect(signCall?.args.slice(0, 6)).toEqual([
      "-Y",
      "sign",
      "-f",
      keyPath,
      "-n",
      "evidence",
    ]);
    expect(signCall?.args[6]).toStartWith(join(tmpdir(), "evidence-sign-"));

    const silent = scripted([
      { command: "ssh-keygen", reply: listing },
      { command: "ssh-keygen", reply: ok(output(0)) },
    ]);
    const silentSigner = await createSshSigner(silent.exec, { keyPath });
    if (!silentSigner.ok) throw new Error(silentSigner.error);
    expect(await silentSigner.value.sign(new Uint8Array([1]))).toEqual({
      ok: false,
      error: "ssh-keygen sign produced no signature file",
    });
    const spawnFailed = scripted([
      { command: "ssh-keygen", reply: listing },
      { command: "ssh-keygen", reply: { ok: false, error: "aborted" } },
    ]);
    const abortedSigner = await createSshSigner(spawnFailed.exec, { keyPath });
    if (!abortedSigner.ok) throw new Error(abortedSigner.error);
    expect(await abortedSigner.value.sign(new Uint8Array([1]))).toEqual({
      ok: false,
      error: "ssh-keygen aborted",
    });
  });

  test("verify distinguishes tooling failures from a negative answer", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const sig = Buffer.from("sig").toString("base64");
    const noTool = scripted([
      { command: "ssh-keygen", reply: { ok: false, error: "spawn-failed" } },
    ]);
    expect(
      await createSshVerifier(noTool.exec, {
        allowedSignersFile: signers,
      }).verify(bytes, "SHA256:abc", sig),
    ).toEqual({ ok: false, error: "ssh-keygen is not installed" });
    expect(noTool.calls[0]?.args.slice(0, 2)).toEqual([
      "-Y",
      "find-principals",
    ]);

    const noPrincipal = scripted([
      {
        command: "ssh-keygen",
        reply: ok(output(255, "", "No principal matched.")),
      },
    ]);
    expect(
      await createSshVerifier(noPrincipal.exec, {
        allowedSignersFile: signers,
      }).verify(bytes, "SHA256:abc", sig),
    ).toEqual(ok(false));
    expect(noPrincipal.calls).toHaveLength(1);

    const emptyPrincipal = scripted([
      { command: "ssh-keygen", reply: ok(output(0, "\n")) },
    ]);
    expect(
      await createSshVerifier(emptyPrincipal.exec, {
        allowedSignersFile: signers,
      }).verify(bytes, "SHA256:abc", sig),
    ).toEqual(ok(false));

    const noShell = scripted([
      { command: "ssh-keygen", reply: ok(output(0, "alice\n")) },
      { command: "ssh-keygen", reply: { ok: false, error: "spawn-failed" } },
    ]);
    expect(
      await createSshVerifier(noShell.exec, {
        allowedSignersFile: signers,
      }).verify(bytes, "SHA256:abc", sig),
    ).toEqual({ ok: false, error: "ssh-keygen is not installed" });
    const shellCall = noShell.calls[1];
    expect(shellCall?.args.slice(0, 2)).toEqual(["-Y", "verify"]);
    expect(noShell.stdins[1]).toEqual(bytes);
    expect(shellCall?.args.slice(2, 8)).toEqual([
      "-f",
      signers,
      "-I",
      "alice",
      "-n",
      "evidence",
    ]);

    const rejected = scripted([
      { command: "ssh-keygen", reply: ok(output(0, "alice\n")) },
      {
        command: "ssh-keygen",
        reply: ok(output(255, "", "Could not verify signature.")),
      },
    ]);
    expect(
      await createSshVerifier(rejected.exec, {
        allowedSignersFile: signers,
      }).verify(bytes, "SHA256:abc", sig),
    ).toEqual(ok(false));

    // Older ssh-keygen may not print the fingerprint: the keyid cannot be
    // cross-checked, and the verdict rests on allowed_signers alone.
    const terse = scripted([
      { command: "ssh-keygen", reply: ok(output(0, "alice\n")) },
      {
        command: "ssh-keygen",
        reply: ok(output(0, 'Good "evidence" signature for alice\n')),
      },
    ]);
    expect(
      await createSshVerifier(terse.exec, {
        allowedSignersFile: signers,
      }).verify(bytes, "SHA256:abc", sig),
    ).toEqual(ok(true));
    const mismatch = scripted([
      { command: "ssh-keygen", reply: ok(output(0, "alice\n")) },
      {
        command: "ssh-keygen",
        reply: ok(output(0, "Good signature with ED25519 key SHA256:other\n")),
      },
    ]);
    expect(
      await createSshVerifier(mismatch.exec, {
        allowedSignersFile: signers,
      }).verify(bytes, "SHA256:abc", sig),
    ).toEqual(ok(false));
  });
});

describe("signing key resolution", () => {
  const reader =
    (values: Readonly<Record<string, string | null>>) =>
    async (key: string): Promise<string | null> =>
      values[key] ?? null;

  test("environment wins, then git ssh signing key when it exists on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evidence-resolve-"));
    const onDisk = join(dir, "id_ed25519");
    writeFileSync(onDisk, "");
    expect(
      await resolveSigningKey(
        { EVIDENCE_SSH_KEY: "/env/key" },
        reader({ "gpg.format": "ssh", "user.signingkey": onDisk }),
      ),
    ).toBe("/env/key");
    expect(
      await resolveSigningKey(
        { EVIDENCE_SSH_KEY: "" },
        reader({ "gpg.format": "ssh", "user.signingkey": onDisk }),
      ),
    ).toBe(onDisk);
    expect(
      await resolveSigningKey(
        {},
        reader({ "gpg.format": "ssh", "user.signingkey": onDisk }),
      ),
    ).toBe(onDisk);
    // Not ssh-format: the signing key is a GPG id, unusable here.
    expect(
      await resolveSigningKey(
        {},
        reader({ "gpg.format": "openpgp", "user.signingkey": onDisk }),
      ),
    ).toBeNull();
    expect(
      await resolveSigningKey({}, reader({ "user.signingkey": onDisk })),
    ).toBeNull();
    expect(
      await resolveSigningKey({}, reader({ "gpg.format": "ssh" })),
    ).toBeNull();
    expect(
      await resolveSigningKey(
        {},
        reader({ "gpg.format": "ssh", "user.signingkey": "" }),
      ),
    ).toBeNull();
    expect(
      await resolveSigningKey(
        {},
        reader({
          "gpg.format": "ssh",
          "user.signingkey": "key::ssh-ed25519 AAAA literal",
        }),
      ),
    ).toBeNull();
    expect(
      await resolveSigningKey(
        {},
        reader({ "gpg.format": "ssh", "user.signingkey": join(dir, "gone") }),
      ),
    ).toBeNull();
  });

  test("git config reader returns trimmed values or null", async () => {
    const fake = scripted([
      { command: "git", reply: ok(output(0, "ssh\n")) },
      { command: "git", reply: ok(output(1)) },
      { command: "git", reply: { ok: false, error: "spawn-failed" } },
      { command: "git", reply: ok(output(0, "  \n")) },
    ]);
    const read = gitConfigReader(fake.exec, "/repo");
    expect(await read("gpg.format")).toBe("ssh");
    expect(await read("user.signingkey")).toBeNull();
    expect(await read("gpg.format")).toBeNull();
    expect(await read("gpg.format")).toBeNull();
    expect(fake.calls[0]).toEqual({
      command: "git",
      args: ["config", "--get", "gpg.format"],
    });
  });

  test("git config reader against a throwaway repository", async () => {
    const repo = mkdtempSync(join(tmpdir(), "evidence-git-"));
    const init = await runProcess("git", ["init", "-q", repo]);
    expect(init.ok && init.value.code).toBe(0);
    // Local (repository-scoped) config only: the user's own git config is
    // never read for a value nor written.
    const set = await runProcess("git", [
      "-C",
      repo,
      "config",
      "--local",
      "evidence.test",
      "value",
    ]);
    expect(set.ok && set.value.code).toBe(0);
    const read = gitConfigReader(runProcess, repo);
    expect(await read("evidence.test")).toBe("value");
    expect(await read("evidence.missing")).toBeNull();
  });
});
