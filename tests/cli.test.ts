// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgv, runCli } from "../src/cli.ts";
import { gitRepo } from "./binding.test.ts";

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (t: string) => out.push(t),
      stderr: (t: string) => err.push(t),
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

const env = {
  EVIDENCE_SESSION_ID: "cli-test",
  EVIDENCE_PROVIDER: "cli",
  EVIDENCE_MODEL: "none",
};

function commit(dir: string, message: string): void {
  execFileSync("git", ["add", "-A", "."], { cwd: dir });
  execFileSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "commit",
      "-q",
      "-m",
      message,
    ],
    { cwd: dir },
  );
}

describe("parseArgv", () => {
  test("splits command, positionals and flags", () => {
    expect(parseArgv(["run", "--only", "a,b", "--json", "id1"])).toEqual({
      command: "run",
      positional: ["id1"],
      flags: { only: "a,b", json: true },
    });
    expect(parseArgv([]).command).toBe("help");
  });
});

describe("evidence CLI", () => {
  test("full path on a fixture: init, accept, gate, defect, verify, attach, decide, prune, compare", async () => {
    const dir = gitRepo();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "sh -c 'test ! -f defect.flag'" } }),
    );
    writeFileSync(join(dir, "bun.lock"), "");
    commit(dir, "scripts");

    const help = io();
    expect(await runCli(["help"], help.io, env)).toBe(0);
    expect(help.out()).toContain("evidence <command>");

    const noRoot = io();
    expect(await runCli(["status", "--cwd", "/"], noRoot.io, env)).toBe(2);
    expect(noRoot.err()).toContain("not a git repository");

    const init = io();
    expect(await runCli(["init", "--cwd", dir], init.io, env)).toBe(0);
    expect(existsSync(join(dir, ".evidence.json"))).toBe(true);
    // Declare the criterion, as the note in the generated recipe asks.
    const recipe = JSON.parse(
      readFileSync(join(dir, ".evidence.json"), "utf8"),
    );
    recipe.checks[0].required = true;
    recipe.checks[0].command = "sh";
    recipe.checks[0].args = ["-c", "test ! -f defect.flag"];
    writeFileSync(join(dir, ".evidence.json"), JSON.stringify(recipe));

    const refused = io();
    expect(
      await runCli(["gate", "--cwd", dir, "--json"], refused.io, env),
    ).toBe(2);
    expect(JSON.parse(refused.out()).error).toContain("jamais acceptée");

    const accept = io();
    expect(
      await runCli(["accept", "--by", "alice", "--cwd", dir], accept.io, env),
    ).toBe(0);

    const gate = io();
    expect(
      await runCli(
        ["gate", "--cwd", dir, "--json", "--requirement", "REQ-7"],
        gate.io,
        env,
      ),
    ).toBe(0);
    const gateOut = JSON.parse(gate.out());
    expect(gateOut.bundle.verdict).toBe("conformant");
    expect(gateOut.bundle.requirement).toBe("REQ-7");
    expect(gateOut.bundle.schema_version).toBe(2);
    expect(gateOut.attestation.keyid).toBeNull();
    expect(existsSync(gateOut.attestation.statement)).toBe(true);

    const reproduced = io();
    expect(
      await runCli(
        ["verify", "--cwd", dir, "--require-reproduced", "--json"],
        reproduced.io,
        env,
      ),
    ).toBe(0);
    expect(JSON.parse(reproduced.out()).comparison.outcome).toBe("reproduced");

    writeFileSync(join(dir, "defect.flag"), "");
    const failing = io();
    expect(await runCli(["gate", "--cwd", dir], failing.io, env)).toBe(1);
    expect(failing.out()).toContain("FAILED");

    const diverged = io();
    expect(
      await runCli(
        ["verify", gateOut.bundle.id, "--cwd", dir, "--require-reproduced"],
        diverged.io,
        env,
      ),
    ).toBe(1);
    expect(diverged.out()).toContain("STALE");

    const compare = io();
    expect(
      await runCli(
        ["compare", "--base", "HEAD", "--cwd", dir, "--json"],
        compare.io,
        env,
      ),
    ).toBe(0);
    const compared = JSON.parse(compare.out());
    expect(compared.bundle.differential.entries[0].classification).toBe(
      "regression",
    );

    const report = join(dir, "runtime.md");
    writeFileSync(report, "**Verdict :** PASS\n");
    const attach = io();
    expect(
      await runCli(
        ["attach", "--kind", "verify-runtime", "--file", report, "--cwd", dir],
        attach.io,
        env,
      ),
    ).toBe(0);
    expect(attach.out()).toContain("PASS");
    const decide = io();
    expect(
      await runCli(
        [
          "decide",
          "--by",
          "bob",
          "--decision",
          "rejected",
          "--note",
          "regression",
          "--cwd",
          dir,
        ],
        decide.io,
        env,
      ),
    ).toBe(0);
    expect(decide.out()).toContain("rejected par bob");
    const show = io();
    expect(await runCli(["show", "--cwd", dir], show.io, env)).toBe(0);
    expect(show.out()).toContain("acceptation rejected");
    expect(show.out()).toContain("attestation : présente, non signée");

    const status = io();
    expect(
      await runCli(["status", "--cwd", dir, "--json"], status.io, env),
    ).toBe(0);
    expect(JSON.parse(status.out()).status).toHaveLength(5);
    const dry = io();
    expect(
      await runCli(
        ["prune", "--keep", "2", "--dry-run", "--cwd", dir, "--json"],
        dry.io,
        env,
      ),
    ).toBe(0);
    expect(JSON.parse(dry.out()).removed).toHaveLength(3);
    const prune = io();
    expect(
      await runCli(["prune", "--keep", "2", "--cwd", dir], prune.io, env),
    ).toBe(0);
    const after = io();
    await runCli(["status", "--cwd", dir, "--json"], after.io, env);
    expect(JSON.parse(after.out()).status).toHaveLength(2);

    const ifPresent = io();
    expect(
      await runCli(
        ["verify", "zzz", "--if-present", "--cwd", dir],
        ifPresent.io,
        env,
      ),
    ).toBe(0);
    for (const bad of [
      ["accept", "--cwd", dir],
      ["attach", "--cwd", dir],
      ["decide", "--cwd", dir],
      ["prune", "--cwd", dir],
      ["compare", "--cwd", dir],
      ["nope", "--cwd", dir],
      ["run", "--accept-recipe", "--cwd", dir],
    ]) {
      const b = io();
      expect(await runCli(bad, b.io, env)).toBe(2);
    }
  });

  test("the binary runs under bun and prints JSON", () => {
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
    const out = execFileSync(
      "bun",
      [
        join(import.meta.dir, "..", "bin", "evidence.ts"),
        "gate",
        "--cwd",
        dir,
        "--json",
        "--accept-recipe",
        "--by",
        "ci",
      ],
      { encoding: "utf8", env: { ...process.env, ...env } },
    );
    expect(JSON.parse(out).bundle.verdict).toBe("conformant");
  });
});
