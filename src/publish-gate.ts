// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

// Publication gate for check logs: a directory of logs is published only when
// every named control has exactly one summary line, and that line is a pass
// that was expected to pass. Absence, a duplicate, a lone negative witness
// (`expected=fail got=fail as-expected`) and a malformed line all withhold.
//
// This module has no import on purpose: its test loads mutated copies of it
// from a temporary directory, where no relative import would resolve.
//
// Summary line, space-separated:
//   <control> <situation> expected=<pass|fail> got=<pass|fail> <as-expected|unexpected>
// A line belongs to a control when its first token is exactly the control name.

export type ControlState = "passed" | "absent" | "not_passed";

export interface ControlOutcome {
  readonly name: string;
  readonly state: ControlState;
  // Lines whose first token is the control name, malformed ones included.
  readonly lines: number;
}

export interface PublishGateReport {
  readonly named: number;
  readonly passed: number;
  readonly absent: number;
  readonly not_passed: number;
  readonly controls: readonly ControlOutcome[];
  readonly publish: boolean;
}

const EXPECTED = new Set(["expected=pass", "expected=fail"]);
const GOT = new Set(["got=pass", "got=fail"]);
const OUTCOME = new Set(["as-expected", "unexpected"]);

function tokenize(summary: string): readonly (readonly string[])[] {
  return summary
    .split(/\r?\n/)
    .map((line) => line.split(/[ \t]+/).filter((token) => token !== ""))
    .filter((tokens) => tokens.length > 0);
}

function isWellFormed(tokens: readonly string[]): boolean {
  const [, , expected = "", got = "", outcome = ""] = tokens;
  return (
    tokens.length === 5 &&
    EXPECTED.has(expected) &&
    GOT.has(got) &&
    OUTCOME.has(outcome)
  );
}

function linePasses(tokens: readonly string[]): boolean {
  return (
    isWellFormed(tokens) &&
    tokens[2] === "expected=pass" &&
    tokens[3] === "got=pass" &&
    tokens[4] === "as-expected"
  );
}

function evaluateControl(
  name: string,
  lines: readonly (readonly string[])[],
): ControlOutcome {
  const matching = lines.filter((tokens) => tokens[0] === name);
  const wellFormed = matching.filter(isWellFormed).length;
  // Two independent conditions: the count is taken on well-formed lines, the
  // verdict on every line of the control, so a malformed line next to a pass
  // withholds through the verdict and a duplicate pass through the count.
  const exactlyOneLine = wellFormed === 1;
  const everyLinePasses = matching.every(linePasses);
  const state: ControlState =
    exactlyOneLine && everyLinePasses
      ? "passed"
      : matching.length === 0
        ? "absent"
        : "not_passed";
  return { name, state, lines: matching.length };
}

export function evaluatePublishGate(
  summary: string,
  named: readonly string[],
): PublishGateReport {
  const lines = tokenize(summary);
  const controls = named.map((name) => evaluateControl(name, lines));
  const count = (state: ControlState): number =>
    controls.filter((control) => control.state === state).length;
  const passed = count("passed");
  // Naming no control never publishes: an empty gate has verified nothing.
  const publish = named.length > 0 && passed === named.length;
  return {
    named: named.length,
    passed,
    absent: count("absent"),
    not_passed: count("not_passed"),
    controls,
    publish,
  };
}

export function formatPublishGate(report: PublishGateReport): string {
  return `named=${report.named} passed=${report.passed} absent=${report.absent} not_passed=${report.not_passed}`;
}
