// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../scripts/check-markers.ts", import.meta.url),
);

// This file is tracked, so it is scanned by the gate it tests: the marker
// values are assembled at run time and never appear as literals here.
const machinePath = ["", "Users", "someone", "project"].join("/");
const markerWord = ["camp", "aign"].join("");

function repoWith(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), "markers-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  // The gate reads the index (`git ls-files`): staging is enough, no commit.
  spawnSync("git", ["add", "-A", "."], { cwd: dir });
  return dir;
}

function scan(dir: string): { code: number | null; out: string; err: string } {
  // A minimal environment: the probe must measure its fixture, not an
  // ambient GIT_DIR or CI variable.
  const result = spawnSync(process.execPath, [script], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

describe("check-markers", () => {
  test("a clean tree passes and prints the volume it examined", () => {
    const dir = repoWith({
      "a.txt": "nothing here\n",
      "src/b.ts": "export const b = 1;\n",
      "LICENSES/X.txt": `${machinePath}\n`,
    });
    const result = scan(dir);
    expect(result.code).toBe(0);
    expect(result.out).toContain("2 files read");
    expect(result.out).toContain("1 exempted");
    expect(result.out).toContain("3 tracked");
    expect(result.out).toContain("6 marker families applied");
  });

  test("a marker on a line fails and names the file, the line and the family", () => {
    const dir = repoWith({
      "a.txt": "nothing here\n",
      "notes.md": `first line\nsee ${machinePath}/x\n`,
    });
    const result = scan(dir);
    expect(result.code).toBe(1);
    expect(result.err).toContain("notes.md:2: machine-path");
    expect(result.err).toContain("1 marker hit");
    expect(result.err).toContain("2 files read");
  });

  test("the content is scanned, not the file name", () => {
    const dir = repoWith({ [`${markerWord}.txt`]: "nothing here\n" });
    const result = scan(dir);
    expect(result.code).toBe(0);
    expect(result.out).toContain("1 files read");
  });

  test("zero files read is a failure, never a clean verdict", () => {
    const empty = scan(repoWith({}));
    expect(empty.code).toBe(2);
    expect(empty.err).toContain("0 files read");
    const onlyExempted = scan(repoWith({ "LICENSES/X.txt": "text\n" }));
    expect(onlyExempted.code).toBe(2);
    expect(onlyExempted.err).toContain("0 files read");
  });

  test("an unreadable tracked file is a failure", () => {
    const dir = repoWith({ "a.txt": "nothing here\n", "gone.txt": "x\n" });
    unlinkSync(join(dir, "gone.txt"));
    const result = scan(dir);
    expect(result.code).toBe(2);
    expect(result.err).toContain("cannot read gone.txt");
  });

  test("outside a git repository the listing fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "markers-nogit-"));
    const result = scan(dir);
    expect(result.code).toBe(2);
    expect(result.err).toContain("cannot list tracked files");
  });
});
