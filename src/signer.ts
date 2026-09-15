// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecFn, ProcessError } from "./exec.ts";
import { fail, ok, type Result } from "./result.ts";

export interface Signer {
  readonly keyid: string;
  // Returns the full SSH signature (armored text) as a base64 blob.
  sign(bytes: Uint8Array): Promise<Result<string>>;
}

export interface Verifier {
  verify(
    bytes: Uint8Array,
    keyid: string,
    signature: string,
  ): Promise<Result<boolean>>;
}

export const DEFAULT_NAMESPACE = "evidence";

const SSH_KEYGEN_TIMEOUT_MS = 60_000;

function describeProcessError(tool: string, error: ProcessError): string {
  return error === "spawn-failed"
    ? `${tool} is not installed`
    : `${tool} ${error}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Every ssh-keygen exchange goes through files in a private temporary
// directory: the tool takes its inputs from paths (sign) or stdin (verify),
// and the directory is removed whatever happens so no message or signature
// lingers in the shared temp folder.
async function withTempDir<T>(
  prefix: string,
  work: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const FINGERPRINT = /\bSHA256:[A-Za-z0-9+/=]+/;

async function fingerprintOf(
  exec: ExecFn,
  publicKeyPath: string,
): Promise<Result<string>> {
  const run = await exec("ssh-keygen", ["-lf", publicKeyPath], {
    timeoutMs: SSH_KEYGEN_TIMEOUT_MS,
  });
  if (!run.ok) return fail(describeProcessError("ssh-keygen", run.error));
  if (run.value.code !== 0)
    return fail(
      `ssh-keygen could not read ${publicKeyPath}: ${run.value.stderr.trim().slice(0, 200)}`,
    );
  const match = FINGERPRINT.exec(run.value.stdout);
  if (match === null)
    return fail(
      `ssh-keygen printed no SHA256 fingerprint for ${publicKeyPath}`,
    );
  return ok(match[0]);
}

export async function createSshSigner(
  exec: ExecFn,
  options: { keyPath: string; namespace?: string | undefined },
): Promise<Result<Signer>> {
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  const publicKeyPath = `${options.keyPath}.pub`;
  if (!(await exists(options.keyPath)))
    return fail(`signing key not found: ${options.keyPath}`);
  if (!(await exists(publicKeyPath)))
    return fail(
      `public key not found next to the signing key: ${publicKeyPath}`,
    );
  const fingerprint = await fingerprintOf(exec, publicKeyPath);
  if (!fingerprint.ok) return fingerprint;
  const keyid = fingerprint.value;
  return ok({
    keyid,
    sign: (bytes) =>
      withTempDir("evidence-sign-", async (dir) => {
        const message = join(dir, "message");
        await writeFile(message, bytes);
        // ssh-keygen signs the named file and writes `<file>.sig` beside it;
        // stdin is not involved, which suits an ExecFn that ignores it.
        const run = await exec(
          "ssh-keygen",
          ["-Y", "sign", "-f", options.keyPath, "-n", namespace, message],
          { timeoutMs: SSH_KEYGEN_TIMEOUT_MS },
        );
        if (!run.ok) return fail(describeProcessError("ssh-keygen", run.error));
        if (run.value.code !== 0)
          return fail(
            `ssh-keygen sign failed: ${run.value.stderr.trim().slice(0, 200)}`,
          );
        let armored: string;
        try {
          armored = await readFile(`${message}.sig`, "utf8");
        } catch {
          return fail("ssh-keygen sign produced no signature file");
        }
        return ok(Buffer.from(armored, "utf8").toString("base64"));
      }),
  });
}

export function createSshVerifier(
  exec: ExecFn,
  options: { allowedSignersFile: string; namespace?: string | undefined },
): Verifier {
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  return {
    verify: async (bytes, keyid, signature) => {
      if (!(await exists(options.allowedSignersFile)))
        return fail(
          `allowed signers file not found: ${options.allowedSignersFile}`,
        );
      return withTempDir("evidence-verify-", async (dir) => {
        const signatureFile = join(dir, "message.sig");
        await writeFile(signatureFile, Buffer.from(signature, "base64"));
        // The allowed_signers principal is not in the envelope (keyid is a
        // fingerprint), so ssh-keygen is asked which principal the signature
        // matches before the verification proper.
        const principals = await exec(
          "ssh-keygen",
          [
            "-Y",
            "find-principals",
            "-s",
            signatureFile,
            "-f",
            options.allowedSignersFile,
          ],
          { timeoutMs: SSH_KEYGEN_TIMEOUT_MS },
        );
        if (!principals.ok)
          return fail(describeProcessError("ssh-keygen", principals.error));
        const principal = principals.value.stdout
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.length > 0);
        // A non-zero exit covers "no principal matched" and an unparsable
        // signature alike: both mean this signature does not verify against
        // the given signers, which is a `false`, not a tooling failure.
        if (principals.value.code !== 0 || principal === undefined)
          return ok(false);
        // `ssh-keygen -Y verify` reads the message from stdin only; the bytes
        // are fed through the process runner, never through a shell.
        const verified = await exec(
          "ssh-keygen",
          [
            "-Y",
            "verify",
            "-f",
            options.allowedSignersFile,
            "-I",
            principal,
            "-n",
            namespace,
            "-s",
            signatureFile,
          ],
          { timeoutMs: SSH_KEYGEN_TIMEOUT_MS, stdin: bytes },
        );
        if (!verified.ok)
          return fail(describeProcessError("ssh-keygen", verified.error));
        if (verified.value.code !== 0) return ok(false);
        // OpenSSH prints the verifying key's fingerprint on success; when it
        // does, an envelope naming a different key is rejected rather than
        // letting the keyid field assert something the signature did not.
        const reported = FINGERPRINT.exec(verified.value.stdout);
        if (reported !== null && reported[0] !== keyid) return ok(false);
        return ok(true);
      });
    },
  };
}

// A literal key (`key::...`) or a path that is absent cannot be handed to
// ssh-keygen -Y sign; resolution reports nothing rather than a broken path.
export async function resolveSigningKey(
  env: Readonly<Record<string, string | undefined>>,
  gitConfigLookup: (key: string) => Promise<string | null>,
): Promise<string | null> {
  const fromEnv = env.EVIDENCE_SSH_KEY;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const format = await gitConfigLookup("gpg.format");
  if (format !== "ssh") return null;
  const signingKey = await gitConfigLookup("user.signingkey");
  if (signingKey === null || signingKey.length === 0) return null;
  if (signingKey.startsWith("key::")) return null;
  return (await exists(signingKey)) ? signingKey : null;
}

export function gitConfigReader(
  exec: ExecFn,
  cwd: string,
): (key: string) => Promise<string | null> {
  return async (key) => {
    const run = await exec("git", ["config", "--get", key], {
      cwd,
      timeoutMs: SSH_KEYGEN_TIMEOUT_MS,
    });
    if (!run.ok || run.value.code !== 0) return null;
    const value = run.value.stdout.trim();
    return value.length > 0 ? value : null;
  };
}
