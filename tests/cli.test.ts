// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

const PASS = "expected=pass got=pass as-expected";

const publishDirs: string[] = [];
afterAll(() => {
  for (const dir of publishDirs) rmSync(dir, { recursive: true, force: true });
});

// A directory outside any git repository: a summary and a tree of logs.
function logsFixture(summary: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "evidence-publish-"));
  publishDirs.push(dir);
  writeFileSync(join(dir, "summary.txt"), `${summary.join("\n")}\n`);
  mkdirSync(join(dir, "logs", "nested", "empty"), { recursive: true });
  writeFileSync(join(dir, "logs", "a.stdout.log"), "first\n");
  writeFileSync(join(dir, "logs", "nested", "b.stderr.log"), "second\n");
  return dir;
}

function publishArgs(dir: string, controls: string): string[] {
  return [
    "publish-logs",
    "--summary",
    "summary.txt",
    "--controls",
    controls,
    "--from",
    "logs",
    "--to",
    "out",
    "--cwd",
    dir,
  ];
}

describe("evidence publish-logs", () => {
  const passing = [`alpha boot ${PASS}`, `beta boot ${PASS}`];

  test("i: a passed gate copies the tree and exits 0, outside any repository", async () => {
    const dir = logsFixture(passing);
    const status = io();
    expect(await runCli(["status", "--cwd", dir], status.io, env)).toBe(2);
    expect(status.err()).toContain("not a git repository");

    const published = io();
    expect(
      await runCli(publishArgs(dir, "alpha,beta"), published.io, env),
    ).toBe(0);
    expect(published.out()).toBe(
      "named=2 passed=2 absent=0 not_passed=0\npublished files=2\n",
    );
    expect(published.err()).toBe("");
    expect(readFileSync(join(dir, "out", "a.stdout.log"), "utf8")).toBe(
      "first\n",
    );
    expect(
      readFileSync(join(dir, "out", "nested", "b.stderr.log"), "utf8"),
    ).toBe("second\n");
    expect(readdirSync(join(dir, "out", "nested", "empty"))).toEqual([]);
  });

  test("i: --json prints the gate report and nothing else", async () => {
    const dir = logsFixture(passing);
    const published = io();
    expect(
      await runCli(
        [...publishArgs(dir, "alpha,beta"), "--json"],
        published.io,
        env,
      ),
    ).toBe(0);
    expect(JSON.parse(published.out())).toEqual({
      named: 2,
      passed: 2,
      absent: 0,
      not_passed: 0,
      controls: [
        { name: "alpha", state: "passed", lines: 1 },
        { name: "beta", state: "passed", lines: 1 },
      ],
      publish: true,
    });
    expect(existsSync(join(dir, "out", "a.stdout.log"))).toBe(true);
  });

  test("ii: a withheld gate names the controls, exits 1 and creates nothing", async () => {
    const dir = logsFixture([
      `alpha boot ${PASS}`,
      "beta boot expected=pass got=fail unexpected",
    ]);
    const withheld = io();
    expect(
      await runCli(publishArgs(dir, "alpha,beta,gamma"), withheld.io, env),
    ).toBe(1);
    expect(withheld.out()).toBe(
      "beta not_passed\ngamma absent\nnamed=3 passed=1 absent=1 not_passed=1\nwithheld\n",
    );
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  test("iii: an existing --to is a usage error and stays intact", async () => {
    const dir = logsFixture(passing);
    mkdirSync(join(dir, "out"));
    writeFileSync(join(dir, "out", "keep.txt"), "kept\n");
    const refused = io();
    expect(await runCli(publishArgs(dir, "alpha,beta"), refused.io, env)).toBe(
      2,
    );
    expect(refused.err()).toBe("evidence: publish-logs: out already exists\n");
    expect(readdirSync(join(dir, "out"))).toEqual(["keep.txt"]);
    expect(readFileSync(join(dir, "out", "keep.txt"), "utf8")).toBe("kept\n");
  });

  test("iv: a symbolic link under --from withholds and creates nothing", async () => {
    const dir = logsFixture(passing);
    symlinkSync(
      join(dir, "summary.txt"),
      join(dir, "logs", "nested", "link.log"),
    );
    const withheld = io();
    expect(await runCli(publishArgs(dir, "alpha,beta"), withheld.io, env)).toBe(
      1,
    );
    expect(withheld.out()).toBe("named=2 passed=2 absent=0 not_passed=0\n");
    expect(withheld.err()).toBe(
      `evidence: withheld: ${join(dir, "logs", "nested", "link.log")} is not a regular file or a directory\n`,
    );
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  test("v: an unreadable summary withholds and creates nothing", async () => {
    const dir = logsFixture(passing);
    const args = publishArgs(dir, "alpha,beta");
    args[2] = "absent.txt";
    const withheld = io();
    expect(await runCli(args, withheld.io, env)).toBe(1);
    expect(withheld.out()).toBe("");
    expect(withheld.err()).toBe(
      "evidence: withheld: cannot read summary absent.txt\n",
    );
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  test("vi: --controls absent, empty or naming a control twice exits 2", async () => {
    const dir = logsFixture(passing);
    const absent = publishArgs(dir, "alpha").filter(
      (arg) => arg !== "--controls" && arg !== "alpha",
    );
    for (const args of [
      absent,
      publishArgs(dir, ","),
      publishArgs(dir, "alpha,beta,alpha"),
    ]) {
      const refused = io();
      expect(await runCli(args, refused.io, env)).toBe(2);
      expect(existsSync(join(dir, "out"))).toBe(false);
    }
    for (const flag of ["--summary", "--from", "--to"]) {
      const args = publishArgs(dir, "alpha,beta");
      args.splice(args.indexOf(flag), 2);
      const refused = io();
      expect(await runCli(args, refused.io, env)).toBe(2);
    }
  });

  test("an unreadable --from, or one that is a link or a file, withholds", async () => {
    const dir = logsFixture(passing);
    symlinkSync(join(dir, "logs"), join(dir, "linked"));
    for (const from of ["missing", "linked", "summary.txt"]) {
      const args = publishArgs(dir, "alpha,beta");
      args[6] = from;
      const withheld = io();
      expect(await runCli([...args, "--json"], withheld.io, env)).toBe(1);
      expect(JSON.parse(withheld.out()).error).toStartWith("withheld: ");
      expect(existsSync(join(dir, "out"))).toBe(false);
    }
  });

  test("a failed copy removes the partial destination it created", async () => {
    const dir = logsFixture(passing);
    // Unreadable for its owner: the listing passes, the read fails.
    chmodSync(join(dir, "logs", "nested", "b.stderr.log"), 0o000);
    const withheld = io();
    expect(await runCli(publishArgs(dir, "alpha,beta"), withheld.io, env)).toBe(
      1,
    );
    expect(withheld.err()).toBe(
      `evidence: withheld: cannot read ${join(dir, "logs", "nested", "b.stderr.log")}\n`,
    );
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  test("a failed copy in --json still prints the gate report, withheld", async () => {
    const dir = logsFixture(passing);
    chmodSync(join(dir, "logs", "nested", "b.stderr.log"), 0o000);
    const withheld = io();
    expect(
      await runCli(
        [...publishArgs(dir, "alpha,beta"), "--json"],
        withheld.io,
        env,
      ),
    ).toBe(1);
    expect(JSON.parse(withheld.out())).toEqual({
      named: 2,
      passed: 2,
      absent: 0,
      not_passed: 0,
      controls: [
        { name: "alpha", state: "passed", lines: 1 },
        { name: "beta", state: "passed", lines: 1 },
      ],
      publish: false,
      error: `withheld: cannot read ${join(dir, "logs", "nested", "b.stderr.log")}`,
    });
    expect(withheld.err()).toBe("");
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  test("a destination whose parent is missing withholds", async () => {
    const dir = logsFixture(passing);
    const args = publishArgs(dir, "alpha,beta");
    args[8] = join("no", "such", "out");
    const withheld = io();
    expect(await runCli(args, withheld.io, env)).toBe(1);
    expect(withheld.err()).toBe(
      `evidence: withheld: cannot create ${join(dir, "no", "such", "out")}\n`,
    );
    expect(existsSync(join(dir, "no"))).toBe(false);
  });
});
