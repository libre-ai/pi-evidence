// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import {
  countLeaks,
  formatLeakReport,
  leakCheck,
  parseReference,
} from "../src/leak-check.ts";

// Every reference value below is synthetic: repeated filler characters that
// resemble no issued credential and no real path.
const VALUES = {
  first: "q".repeat(24),
  second: `w${"7".repeat(20)}`,
  third: "v".repeat(18),
} as const;

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

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

const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

// A directory outside any git repository, with a reference and named logs.
function fixture(
  reference: string,
  logs: Readonly<Record<string, string>>,
): string {
  const dir = mkdtempSync(join(tmpdir(), "evidence-leak-"));
  created.push(dir);
  writeFileSync(join(dir, "reference.txt"), reference);
  for (const [name, content] of Object.entries(logs))
    writeFileSync(join(dir, name), content);
  return dir;
}

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  // Everything the command printed, for the no-disclosure assertions.
  readonly printed: string;
}

async function run(dir: string, args: readonly string[]): Promise<Run> {
  const sink = io();
  const code = await runCli(["leak-check", ...args, "--cwd", dir], sink.io, {});
  return {
    code,
    out: sink.out(),
    err: sink.err(),
    printed: sink.out() + sink.err(),
  };
}

function expectNoValue(printed: string): void {
  for (const value of Object.values(VALUES))
    expect(printed).not.toContain(value);
}

describe("parseReference", () => {
  test("one value per line, empty lines ignored, duplicates collapsed", () => {
    const values = parseReference(bytes("aa\n\nbb\naa\n\n"));
    expect(values.map((value) => new TextDecoder().decode(value))).toEqual([
      "aa",
      "bb",
    ]);
  });

  test("CRLF endings are removed and a last line needs no ending", () => {
    const values = parseReference(bytes("aa\r\n\r\nbb"));
    expect(values.map((value) => new TextDecoder().decode(value))).toEqual([
      "aa",
      "bb",
    ]);
  });

  test("values are compared as bytes, valid text or not", () => {
    const values = parseReference(new Uint8Array([0xff, 0xfe, 0x0a, 0xff]));
    expect(values.map((value) => [...value])).toEqual([[0xff, 0xfe], [0xff]]);
    const report = countLeaks(values, [
      { file: "raw.log", bytes: new Uint8Array([0x00, 0xff, 0xfe, 0x00]) },
    ]);
    expect(report.leaking).toEqual([{ file: "raw.log", leaks: 2 }]);
  });
});

describe("countLeaks and formatLeakReport", () => {
  test("counters cover every log, leaking or not", () => {
    const report = countLeaks(parseReference(bytes("aa\nbb\n")), [
      { file: "one.log", bytes: bytes("xx aa xx") },
      { file: "two.log", bytes: bytes("clean") },
    ]);
    expect(report).toEqual({
      files: 2,
      bytes: 13,
      reference: 2,
      leaks: 1,
      leaking: [{ file: "one.log", leaks: 1 }],
    });
    expect(formatLeakReport(report)).toBe(
      "one.log leaks=1\nfiles=2 bytes=13 reference=2 leaks=1",
    );
  });
});

describe("evidence leak-check", () => {
  test("a: a reference value present in a log names the file and exits 1", async () => {
    const dir = fixture(`${VALUES.first}\n`, {
      "a.log": `start ${VALUES.first} end\n`,
      "b.log": "nothing here\n",
    });
    const result = await run(dir, [
      "--reference",
      "reference.txt",
      "a.log",
      "b.log",
    ]);
    expect(result.code).toBe(1);
    expect(result.out).toBe(
      "a.log leaks=1\nfiles=2 bytes=48 reference=1 leaks=1\n",
    );
    expectNoValue(result.printed);
  });

  test("b: no value present exits 0 with the counters", async () => {
    const dir = fixture(`${VALUES.first}\n${VALUES.second}\n`, {
      "a.log": "nothing here\n",
    });
    const result = await run(dir, ["--reference", "reference.txt", "a.log"]);
    expect(result.code).toBe(0);
    expect(result.out).toBe("files=1 bytes=13 reference=2 leaks=0\n");
    expect(result.err).toBe("");
  });

  test("c: an empty reference, or one made of empty lines, exits 1", async () => {
    for (const reference of ["", "\n\r\n\n"]) {
      const dir = fixture(reference, { "a.log": "nothing here\n" });
      const result = await run(dir, ["--reference", "reference.txt", "a.log"]);
      expect(result.code).toBe(1);
      expect(result.out).toBe("files=1 bytes=13 reference=0 leaks=0\n");
    }
  });

  test("d: two distinct values in one log, one repeated, count 2", async () => {
    const dir = fixture(
      `${VALUES.first}\n${VALUES.second}\n${VALUES.third}\n`,
      {
        "a.log": `${VALUES.first} ${VALUES.second} ${VALUES.first}\n`,
      },
    );
    const result = await run(dir, [
      "--reference",
      "reference.txt",
      "a.log",
      "--json",
    ]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toEqual({
      files: 1,
      bytes: 72,
      reference: 3,
      leaks: 2,
      leaking: [{ file: "a.log", leaks: 2 }],
    });
    expectNoValue(result.printed);
  });

  test("e: the same value in two logs counts 2 and names both", async () => {
    const dir = fixture(`${VALUES.first}\n`, {
      "a.log": VALUES.first,
      "b.log": `x${VALUES.first}x`,
      "c.log": "clean",
    });
    const result = await run(dir, [
      "--reference",
      "reference.txt",
      "a.log",
      "b.log",
      "c.log",
    ]);
    expect(result.code).toBe(1);
    expect(result.out).toBe(
      [
        "a.log leaks=1",
        "b.log leaks=1",
        "files=3 bytes=55 reference=1 leaks=2",
        "",
      ].join("\n"),
    );
    expectNoValue(result.printed);
  });

  test("f: a CRLF reference still finds its value", async () => {
    const dir = fixture(`${VALUES.first}\r\n${VALUES.second}\r\n`, {
      "a.log": `start ${VALUES.second} end\n`,
    });
    const result = await run(dir, ["--reference", "reference.txt", "a.log"]);
    expect(result.code).toBe(1);
    expect(result.out).toBe(
      "a.log leaks=1\nfiles=1 bytes=32 reference=2 leaks=1\n",
    );
    expectNoValue(result.printed);
  });

  test("g: an unreadable log or reference exits 1 and names a path only", async () => {
    const dir = fixture(`${VALUES.first}\n`, { "a.log": VALUES.first });
    const noLog = await run(dir, [
      "--reference",
      "reference.txt",
      "a.log",
      "missing.log",
    ]);
    expect(noLog.code).toBe(1);
    expect(noLog.out).toBe("");
    expect(noLog.err).toBe("evidence: cannot read log missing.log\n");
    expectNoValue(noLog.printed);

    const noReference = await run(dir, ["--reference", "absent.txt", "a.log"]);
    expect(noReference.code).toBe(1);
    expect(noReference.err).toBe(
      "evidence: cannot read reference absent.txt\n",
    );
    expectNoValue(noReference.printed);

    const asJson = await run(dir, [
      "--reference",
      "absent.txt",
      "a.log",
      "--json",
    ]);
    expect(asJson.code).toBe(1);
    expect(JSON.parse(asJson.out)).toEqual({
      error: "cannot read reference absent.txt",
    });

    // A directory named as a log is unreadable too, not an empty log.
    const direct = await leakCheck(join(dir, "reference.txt"), [dir]);
    expect(direct).toEqual({ ok: false, error: `cannot read log ${dir}` });
  });

  test("h: no output channel ever carries a reference value", async () => {
    const dir = fixture(
      `${VALUES.first}\n${VALUES.second}\n${VALUES.third}\n`,
      {
        "a.log": `${VALUES.first}\n${VALUES.second}\n`,
        "b.log": `${VALUES.third}${VALUES.third}\n`,
      },
    );
    const args = ["--reference", "reference.txt", "a.log", "b.log"];
    const human = await run(dir, args);
    const machine = await run(dir, [...args, "--json"]);
    const failing = await run(dir, [...args, "missing.log"]);
    expect(human.code).toBe(1);
    expect(machine.code).toBe(1);
    expect(JSON.parse(machine.out).leaks).toBe(3);
    for (const result of [human, machine, failing]) {
      for (const value of Object.values(VALUES)) {
        expect(result.out).not.toContain(value);
        expect(result.err).not.toContain(value);
      }
    }
  });

  test("h: a workstation path in the reference is not printed through --cwd", async () => {
    // The fixture directory itself is a reference value: resolving the log
    // paths against --cwd would print it on every channel.
    const dir = fixture("", {});
    writeFileSync(join(dir, "reference.txt"), `${dir}\n${VALUES.first}\n`);
    writeFileSync(join(dir, "a.log"), `cwd is ${dir}/work\n`);
    const args = ["--reference", "reference.txt", "a.log"];
    const human = await run(dir, args);
    const machine = await run(dir, [...args, "--json"]);
    const failing = await run(dir, [...args, "missing.log"]);
    const failingJson = await run(dir, [...args, "missing.log", "--json"]);
    expect(human.code).toBe(1);
    expect(human.out).toStartWith("a.log leaks=1\n");
    expect(JSON.parse(machine.out).leaking).toEqual([
      { file: "a.log", leaks: 1 },
    ]);
    expect(failing.err).toBe("evidence: cannot read log missing.log\n");
    for (const result of [human, machine, failing, failingJson]) {
      expect(result.out).not.toContain(dir);
      expect(result.err).not.toContain(dir);
    }
  });

  test("h: a log path that holds a reference value is masked, whole", async () => {
    const dir = fixture(`${VALUES.first}\n`, {
      "clean.log": "clean",
      [`${VALUES.first}.log`]: VALUES.first,
    });
    const args = ["--reference", "reference.txt", "clean.log"];
    const leaking = await run(dir, [...args, `${VALUES.first}.log`]);
    expect(leaking.out).toBe(
      "[masked log 2] leaks=1\nfiles=2 bytes=29 reference=1 leaks=1\n",
    );
    const missing = await run(dir, [...args, `${VALUES.third}${VALUES.first}`]);
    expect(missing.err).toBe("evidence: cannot read log [masked log 2]\n");
    expectNoValue(leaking.printed + missing.printed);
  });

  test("usage: a missing --reference or an empty log list exits 2", async () => {
    const dir = fixture(`${VALUES.first}\n`, { "a.log": "clean" });
    expect((await run(dir, ["a.log"])).code).toBe(2);
    expect((await run(dir, ["--reference", "reference.txt"])).code).toBe(2);
  });

  test("paths resolve against the current directory without --cwd", async () => {
    const dir = fixture(`${VALUES.first}\n`, { "a.log": "clean" });
    const sink = io();
    const code = await runCli(
      [
        "leak-check",
        "--reference",
        join(dir, "reference.txt"),
        join(dir, "a.log"),
      ],
      sink.io,
      {},
    );
    expect(code).toBe(0);
    expect(sink.out()).toBe("files=1 bytes=5 reference=1 leaks=0\n");
  });
});
