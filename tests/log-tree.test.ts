// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyLogTree, listLogTree } from "../src/log-tree.ts";

const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

// logs/nested/b.log inside the checked tree, and an outside directory whose
// layout mirrors it with content that must never be published.
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "evidence-tree-"));
  created.push(dir);
  mkdirSync(join(dir, "logs", "nested"), { recursive: true });
  writeFileSync(join(dir, "logs", "a.log"), "first\n");
  writeFileSync(join(dir, "logs", "nested", "b.log"), "second\n");
  mkdirSync(join(dir, "outside"));
  writeFileSync(join(dir, "outside", "b.log"), "outside\n");
  return dir;
}

describe("copyLogTree", () => {
  test("copies the listed tree", async () => {
    const dir = fixture();
    const copied = await copyLogTree(join(dir, "logs"), join(dir, "out"));
    expect(copied).toEqual({ ok: true, value: 2 });
    expect(readFileSync(join(dir, "out", "nested", "b.log"), "utf8")).toBe(
      "second\n",
    );
  });

  test("an intermediate directory swapped for a link after the listing is refused", async () => {
    const dir = fixture();
    const nested = join(dir, "logs", "nested");
    const copied = await copyLogTree(
      join(dir, "logs"),
      join(dir, "out"),
      async () => {
        renameSync(nested, join(dir, "kept"));
        symlinkSync(join(dir, "outside"), nested);
      },
    );
    expect(copied).toEqual({
      ok: false,
      error: `${join(nested, "b.log")} is not the file that was listed`,
    });
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  test("a listed directory that is a link at listing time is refused", async () => {
    const dir = fixture();
    symlinkSync(join(dir, "outside"), join(dir, "linked"));
    expect(await listLogTree(join(dir, "linked"))).toEqual({
      ok: false,
      error: `${join(dir, "linked")} is not a directory`,
    });
  });
});
