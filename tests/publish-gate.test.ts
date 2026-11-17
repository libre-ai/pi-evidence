// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as original from "../src/publish-gate.ts";

type Gate = typeof original;

const PASS = "expected=pass got=pass as-expected";
const NAMED = ["alpha", "beta", "k"] as const;
const OTHERS = [`alpha boot ${PASS}`, `beta boot ${PASS}`];

interface Case {
  readonly id: number;
  readonly title: string;
  readonly summary: readonly string[];
  readonly counters: string;
  readonly publish: boolean;
  readonly state: original.ControlState;
  readonly lines: number;
}

// Expected values come from the specification of the gate, one row per rule;
// `state` and `lines` describe the control `k`, the other two always pass.
const CASES: readonly Case[] = [
  {
    id: 1,
    title: "one passing line per named control",
    summary: [...OTHERS, `k boot ${PASS}`],
    counters: "named=3 passed=3 absent=0 not_passed=0",
    publish: true,
    state: "passed",
    lines: 1,
  },
  {
    id: 2,
    title: "a line that failed against a pass expectation",
    summary: [...OTHERS, "k boot expected=pass got=fail unexpected"],
    counters: "named=3 passed=2 absent=0 not_passed=1",
    publish: false,
    state: "not_passed",
    lines: 1,
  },
  {
    id: 3,
    title: "a control with no line",
    summary: [...OTHERS],
    counters: "named=3 passed=2 absent=1 not_passed=0",
    publish: false,
    state: "absent",
    lines: 0,
  },
  {
    id: 4,
    title: "a control with two passing lines",
    summary: [...OTHERS, `k boot ${PASS}`, `k again ${PASS}`],
    counters: "named=3 passed=2 absent=0 not_passed=1",
    publish: false,
    state: "not_passed",
    lines: 2,
  },
  {
    id: 5,
    title: "a control with only a negative witness",
    summary: [...OTHERS, "k witness expected=fail got=fail as-expected"],
    counters: "named=3 passed=2 absent=0 not_passed=1",
    publish: false,
    state: "not_passed",
    lines: 1,
  },
  {
    id: 6,
    title: "a passing line for k-2 does not count for k",
    summary: [...OTHERS, `k-2 boot ${PASS}`],
    counters: "named=3 passed=2 absent=1 not_passed=0",
    publish: false,
    state: "absent",
    lines: 0,
  },
  {
    id: 7,
    title: "a passing line next to a malformed line",
    summary: [...OTHERS, `k boot ${PASS}`, "k boot expected=pass"],
    counters: "named=3 passed=2 absent=0 not_passed=1",
    publish: false,
    state: "not_passed",
    lines: 2,
  },
];

// Ids of the cases whose expected values the given implementation misses.
function failingCases(gate: Gate): number[] {
  return CASES.filter((row) => {
    const report = gate.evaluatePublishGate(row.summary.join("\n"), NAMED);
    const k = report.controls.find((control) => control.name === "k");
    return !(
      gate.formatPublishGate(report) === row.counters &&
      report.publish === row.publish &&
      report.named === report.passed + report.absent + report.not_passed &&
      k?.state === row.state &&
      k.lines === row.lines
    );
  }).map((row) => row.id);
}

describe("evaluatePublishGate", () => {
  for (const row of CASES) {
    test(`case ${row.id}: ${row.title}`, () => {
      const report = original.evaluatePublishGate(
        row.summary.join("\n"),
        NAMED,
      );
      expect(original.formatPublishGate(report)).toBe(row.counters);
      expect(report.publish).toBe(row.publish);
      expect(report.named).toBe(
        report.passed + report.absent + report.not_passed,
      );
      expect(report.controls.map((control) => control.name)).toEqual([
        ...NAMED,
      ]);
      expect(report.controls[2]).toEqual({
        name: "k",
        state: row.state,
        lines: row.lines,
      });
    });
  }

  test("the whole table holds against the original", () => {
    expect(failingCases(original)).toEqual([]);
  });

  test("line endings, blank lines and repeated spaces do not change a verdict", () => {
    const report = original.evaluatePublishGate(
      `\r\nalpha  boot\t${PASS}\r\n\r\n`,
      ["alpha"],
    );
    expect(report).toEqual({
      named: 1,
      passed: 1,
      absent: 0,
      not_passed: 0,
      controls: [{ name: "alpha", state: "passed", lines: 1 }],
      publish: true,
    });
  });

  test("a lone malformed line and an inconsistent line withhold", () => {
    for (const line of [
      "alpha boot expected=pass got=pass",
      "alpha boot expected=pass got=pass as-expected extra",
      "alpha boot expected=maybe got=pass as-expected",
      "alpha boot expected=pass got=pass unexpected",
    ]) {
      const report = original.evaluatePublishGate(line, ["alpha"]);
      expect(original.formatPublishGate(report)).toBe(
        "named=1 passed=0 absent=0 not_passed=1",
      );
      expect(report.publish).toBe(false);
    }
  });

  test("naming no control never publishes", () => {
    const report = original.evaluatePublishGate(`alpha boot ${PASS}`, []);
    expect(original.formatPublishGate(report)).toBe(
      "named=0 passed=0 absent=0 not_passed=0",
    );
    expect(report.publish).toBe(false);
  });
});

// Each mutant is one textual substitution on a copy of the module; the cases
// it must turn red are part of the specification, not read from a run.
const MUTANTS: readonly {
  readonly id: string;
  readonly find: string;
  readonly replace: string;
  readonly red: readonly number[];
}[] = [
  {
    id: "M1-verdict-ignored",
    find: "const everyLinePasses = matching.every(linePasses);",
    replace: "const everyLinePasses = true;",
    red: [2, 5, 7],
  },
  {
    id: "M2-count-ignored",
    find: "const exactlyOneLine = wellFormed === 1;",
    replace: "const exactlyOneLine = true;",
    red: [3, 4, 6],
  },
  {
    id: "M3-forced-publish",
    find: "const publish = named.length > 0 && passed === named.length;",
    replace: "const publish = true;",
    red: [2, 3, 4, 5, 6, 7],
  },
];

describe("publish gate mutants", () => {
  const source = readFileSync(
    join(import.meta.dir, "..", "src", "publish-gate.ts"),
    "utf8",
  );
  // The copies live under a `node_modules` directory of the temporary
  // directory: Bun's coverage leaves such files out, and a mutant, whose dead
  // branch is the point, would otherwise fall under the per-file threshold.
  const root = mkdtempSync(join(tmpdir(), "evidence-gate-mutant-"));
  const directory = join(root, "node_modules");
  mkdirSync(directory);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  for (const mutant of MUTANTS) {
    test(`${mutant.id} turns cases ${mutant.red.join(", ")} red`, async () => {
      const mutated = source.replace(mutant.find, mutant.replace);
      // A substitution that did not apply would test the original twice.
      expect(mutated).not.toBe(source);
      const file = join(directory, `${mutant.id}.ts`);
      writeFileSync(file, mutated);
      const gate = (await import(file)) as Gate;
      const red = failingCases(gate);
      expect(red.length).toBeGreaterThan(0);
      expect(red).toEqual([...mutant.red]);
    });
  }
});
