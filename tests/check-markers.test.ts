// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

// Only PATH: a fixture command that inherits GIT_DIR, GIT_WORK_TREE or
// GIT_INDEX_FILE would run against the ambient repository, not its fixture.
function cleanEnv(): Record<string, string> {
  return { PATH: process.env.PATH ?? "" };
}

function git(dir: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: cleanEnv(),
  });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function repoWith(
  files: Readonly<Record<string, string>>,
  links: Readonly<Record<string, string>> = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "markers-"));
  git(dir, "init", "-q");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  for (const [name, target] of Object.entries(links)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    symlinkSync(target, join(dir, name));
  }
  // The gate reads the index (`git ls-files`): staging is enough, no commit.
  git(dir, "add", "-A", ".");
  return dir;
}

function scan(dir: string): { code: number | null; out: string; err: string } {
  // A minimal environment: the probe must measure its fixture, not an
  // ambient GIT_DIR or CI variable.
  const result = spawnSync(process.execPath, [script], {
    cwd: dir,
    encoding: "utf8",
    env: cleanEnv(),
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

// The counters printed on the volume line, by label.
function counters(line: string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const match of line.matchAll(/(\d+) ([a-z][a-z ]*[a-z])/g))
    found[match[2] as string] = Number(match[1]);
  return found;
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
    // The verdict names how many families it applied, and never zero: a scan
    // that applied no pattern has verified nothing.
    expect(counters(result.out)["marker families applied"]).toBeGreaterThan(0);
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

  test("the fixture ignores an ambient GIT_DIR and leaves that repository untouched", () => {
    const ambient = repoWith({ "real.txt": "ambient\n" });
    const saved = {
      dir: process.env.GIT_DIR,
      tree: process.env.GIT_WORK_TREE,
    };
    process.env.GIT_DIR = join(ambient, ".git");
    process.env.GIT_WORK_TREE = ambient;
    let dir: string;
    try {
      dir = repoWith({ "a.txt": "nothing here\n" });
    } finally {
      // Assigning undefined would store the string "undefined".
      if (saved.dir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved.dir;
      if (saved.tree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = saved.tree;
    }
    expect(git(ambient, "ls-files")).toBe("real.txt\n");
    expect(git(dir, "ls-files")).toBe("a.txt\n");
  });

  test("a tracked symbolic link is counted apart and never read through its target", () => {
    const outside = mkdtempSync(join(tmpdir(), "markers-outside-"));
    writeFileSync(join(outside, "secret.txt"), `${machinePath}/x\n`);
    mkdirSync(join(outside, "folder"));
    const dir = repoWith(
      { "a.txt": "nothing here\n" },
      {
        // Relative targets: what git versions is the target text, and these
        // carry no marker. The file behind the first one does.
        "link.txt": join("..", outside.split("/").at(-1) ?? "", "secret.txt"),
        dangling: "nowhere",
        dirlink: join("..", outside.split("/").at(-1) ?? "", "folder"),
      },
    );
    const result = scan(dir);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    const volume = counters(result.out);
    expect(volume["files read"]).toBe(1);
    expect(volume.unreadable).toBe(0);
    expect(volume["symbolic links not followed"]).toBe(3);
    expect(volume.tracked).toBe(4);
  });

  test("the target text of a tracked symbolic link is scanned: git versions it", () => {
    const dir = repoWith(
      { "a.txt": "nothing here\n" },
      { "link.txt": `${machinePath}/x` },
    );
    const result = scan(dir);
    expect(result.code).toBe(1);
    expect(result.err).toContain("link.txt: link target: machine-path");
  });

  test("a regular tracked file replaced by a link in the working tree is unreadable, not followed", () => {
    const outside = mkdtempSync(join(tmpdir(), "markers-outside-"));
    writeFileSync(join(outside, "clean.txt"), "nothing here\n");
    const dir = repoWith({ "a.txt": "nothing here\n", "b.txt": "x\n" });
    unlinkSync(join(dir, "b.txt"));
    symlinkSync(join(outside, "clean.txt"), join(dir, "b.txt"));
    const result = scan(dir);
    expect(result.code).toBe(2);
    expect(result.err).toContain("cannot read b.txt");
    expect(result.err).toContain("1 unreadable");
  });

  test("a tracked link missing from the working tree is unreadable: its target text was not scanned", () => {
    const dir = repoWith({ "a.txt": "nothing here\n" }, { link: "a.txt" });
    unlinkSync(join(dir, "link"));
    const result = scan(dir);
    expect(result.code).toBe(2);
    expect(result.err).toContain("cannot read link");
    const volume = counters(result.err);
    expect(volume.unreadable).toBe(1);
    expect(volume["symbolic links not followed"]).toBe(0);
  });

  test("a submodule entry is counted apart, not reported unreadable", () => {
    const dir = repoWith({ "a.txt": "nothing here\n" });
    mkdirSync(join(dir, "sub"));
    git(
      dir,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${"a".repeat(40)},sub`,
    );
    const result = scan(dir);
    expect(result.code).toBe(0);
    const volume = counters(result.out);
    expect(volume["submodule entries not scanned"]).toBe(1);
    expect(volume.unreadable).toBe(0);
    expect(volume.tracked).toBe(2);
  });

  test("the listing starts at the repository root whatever the current directory", () => {
    const dir = repoWith({
      "a.txt": "nothing here\n",
      "notes.md": `see ${machinePath}/x\n`,
      "src/b.ts": "export const b = 1;\n",
    });
    const result = scan(join(dir, "src"));
    expect(result.code).toBe(1);
    expect(result.err).toContain("notes.md:1: machine-path");
    expect(result.err).toContain("3 tracked");
  });

  test("the counters sum to the tracked entries", () => {
    const dir = repoWith(
      {
        "a.txt": "nothing here\n",
        "src/b.ts": "export const b = 1;\n",
        "gone.txt": "x\n",
        "LICENSES/X.txt": "text\n",
      },
      { link: "a.txt", "LICENSES/link": "X.txt" },
    );
    unlinkSync(join(dir, "gone.txt"));
    mkdirSync(join(dir, "sub"));
    git(
      dir,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${"a".repeat(40)},sub`,
    );
    const result = scan(dir);
    expect(result.code).toBe(2);
    const volume = counters(result.err);
    expect(volume.tracked).toBe(7);
    expect(
      (volume["files read"] ?? Number.NaN) +
        (volume.unreadable ?? Number.NaN) +
        (volume.exempted ?? Number.NaN) +
        (volume["symbolic links not followed"] ?? Number.NaN) +
        (volume["submodule entries not scanned"] ?? Number.NaN),
    ).toBe(volume.tracked as number);
    expect(volume["files read"]).toBe(2);
    expect(volume.unreadable).toBe(1);
    expect(volume.exempted).toBe(2);
  });
});
