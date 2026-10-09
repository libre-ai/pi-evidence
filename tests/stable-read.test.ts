// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NODE_STABLE_READ_FS,
  readStableFile,
  type StableReadFs,
} from "../src/stable-read.ts";

function workdir(): string {
  return mkdtempSync(join(tmpdir(), "evidence-stable-"));
}

// Runs `mutate` once, right before the first read on the opened handle: the
// file changes after it was inspected and opened, while it is being read.
function mutatingOnFirstRead(mutate: () => void): StableReadFs {
  let mutated = false;
  return {
    lstat: NODE_STABLE_READ_FS.lstat,
    async open(path, flags) {
      const handle = await NODE_STABLE_READ_FS.open(path, flags);
      return {
        stat: () => handle.stat(),
        close: () => handle.close(),
        async read(buffer, offset, length, position) {
          if (!mutated) {
            mutated = true;
            mutate();
          }
          return handle.read(buffer, offset, length, position);
        },
      };
    },
  };
}

describe("stable file read", () => {
  test("returns the bytes and their sha256", async () => {
    const file = join(workdir(), "report.md");
    writeFileSync(file, "**Verdict :** PASS\n");
    const read = await readStableFile(file, 1024);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.bytes.toString("utf8")).toBe("**Verdict :** PASS\n");
    expect(read.value.sha256).toBe(
      createHash("sha256").update("**Verdict :** PASS\n").digest("hex"),
    );
  });

  test("reads an empty file", async () => {
    const file = join(workdir(), "empty.md");
    writeFileSync(file, "");
    const read = await readStableFile(file, 1024);
    expect(read.ok && read.value.bytes.length).toBe(0);
  });

  test("refuses a symbolic link, even to a regular file", async () => {
    const dir = workdir();
    writeFileSync(join(dir, "target.md"), "content\n");
    symlinkSync(join(dir, "target.md"), join(dir, "link.md"));
    const read = await readStableFile(join(dir, "link.md"), 1024);
    expect(read.ok).toBe(false);
    expect(!read.ok && read.error).toContain("not a regular file");
  });

  test("refuses a directory and a missing path", async () => {
    const dir = workdir();
    mkdirSync(join(dir, "sub"));
    const directory = await readStableFile(join(dir, "sub"), 1024);
    expect(!directory.ok && directory.error).toContain("not a regular file");
    const missing = await readStableFile(join(dir, "absent.md"), 1024);
    expect(!missing.ok && missing.error).toContain("cannot read");
  });

  test("refuses a file above the size bound without reading it", async () => {
    const file = join(workdir(), "big.md");
    writeFileSync(file, "x".repeat(11));
    const read = await readStableFile(file, 10);
    expect(!read.ok && read.error).toContain("exceeds 10 bytes");
    expect((await readStableFile(file, 11)).ok).toBe(true);
  });

  test("refuses a file that grows while it is read", async () => {
    const file = join(workdir(), "growing.md");
    writeFileSync(file, "first\n");
    const read = await readStableFile(
      file,
      1024,
      mutatingOnFirstRead(() => appendFileSync(file, "appended\n")),
    );
    expect(!read.ok && read.error).toContain("changed while it was read");
  });

  test("refuses a file rewritten in place with the same size", async () => {
    const file = join(workdir(), "rewritten.md");
    writeFileSync(file, "Verdict: FAIL\n");
    // Linux stamps files with a coarse clock: an in-place rewrite within the
    // same tick keeps mtime, so the original version is dated in the past.
    utimesSync(file, new Date("2026-01-01"), new Date("2026-01-01"));
    const read = await readStableFile(
      file,
      1024,
      mutatingOnFirstRead(() => writeFileSync(file, "Verdict: PASS\n")),
    );
    expect(!read.ok && read.error).toContain("changed while it was read");
  });

  test("refuses a path replaced by another file while it is read", async () => {
    const dir = workdir();
    const file = join(dir, "replaced.md");
    writeFileSync(file, "original\n");
    const read = await readStableFile(
      file,
      1024,
      mutatingOnFirstRead(() => {
        writeFileSync(join(dir, "other.md"), "original\n");
        renameSync(join(dir, "other.md"), file);
      }),
    );
    // Unlinking the open inode moves its ctime, unless the coarse Linux clock
    // has not ticked since the file was created: then only the final
    // inspection sees the new inode. Either check refuses the read.
    expect(!read.ok && read.error).toMatch(
      /changed while it was read|replaced while it was read/,
    );
  });

  test("refuses a path removed while it is read", async () => {
    const file = join(workdir(), "removed.md");
    writeFileSync(file, "content\n");
    const read = await readStableFile(
      file,
      1024,
      mutatingOnFirstRead(() => unlinkSync(file)),
    );
    expect(!read.ok && read.error).toMatch(
      /changed while it was read|replaced while it was read/,
    );
  });

  // After the last fstat only the final inspection of the path remains: a
  // replacement or removal at that point is caught by it alone.
  test("refuses a path replaced or removed after the read", async () => {
    const dir = workdir();
    const changingOnClose = (change: () => void): StableReadFs => ({
      lstat: NODE_STABLE_READ_FS.lstat,
      async open(path, flags) {
        const handle = await NODE_STABLE_READ_FS.open(path, flags);
        return {
          stat: () => handle.stat(),
          read: (buffer, offset, length, position) =>
            handle.read(buffer, offset, length, position),
          async close() {
            await handle.close();
            change();
          },
        };
      },
    });
    const replaced = join(dir, "replaced-late.md");
    writeFileSync(replaced, "original\n");
    const afterReplace = await readStableFile(
      replaced,
      1024,
      changingOnClose(() => {
        writeFileSync(join(dir, "other.md"), "original\n");
        renameSync(join(dir, "other.md"), replaced);
      }),
    );
    expect(!afterReplace.ok && afterReplace.error).toContain(
      "replaced while it was read",
    );
    const removed = join(dir, "removed-late.md");
    writeFileSync(removed, "content\n");
    const afterRemove = await readStableFile(
      removed,
      1024,
      changingOnClose(() => unlinkSync(removed)),
    );
    expect(!afterRemove.ok && afterRemove.error).toContain(
      "replaced while it was read",
    );
  });

  test("refuses a file swapped between inspection and open", async () => {
    const dir = workdir();
    const file = join(dir, "swapped.md");
    writeFileSync(file, "inspected\n");
    const swapping: StableReadFs = {
      lstat: NODE_STABLE_READ_FS.lstat,
      async open(path, flags) {
        writeFileSync(join(dir, "other.md"), "inspected\n");
        renameSync(join(dir, "other.md"), file);
        return NODE_STABLE_READ_FS.open(path, flags);
      },
    };
    const read = await readStableFile(file, 1024, swapping);
    expect(!read.ok && read.error).toContain("changed before it was read");
  });

  test("reports a failing read as unreadable and closes the handle", async () => {
    const file = join(workdir(), "failing.md");
    writeFileSync(file, "content\n");
    let closed = false;
    const failing: StableReadFs = {
      lstat: NODE_STABLE_READ_FS.lstat,
      async open(path, flags) {
        const handle = await NODE_STABLE_READ_FS.open(path, flags);
        return {
          stat: () => handle.stat(),
          read: async () => {
            throw new Error("EIO");
          },
          async close() {
            closed = true;
            await handle.close();
          },
        };
      },
    };
    const read = await readStableFile(file, 1024, failing);
    expect(!read.ok && read.error).toContain("cannot read");
    expect(closed).toBe(true);
  });

  test("reports a failed open as unreadable", async () => {
    const file = join(workdir(), "unopenable.md");
    writeFileSync(file, "content\n");
    const refusing: StableReadFs = {
      lstat: NODE_STABLE_READ_FS.lstat,
      open: async () => {
        throw new Error("ELOOP");
      },
    };
    const read = await readStableFile(file, 1024, refusing);
    expect(!read.ok && read.error).toContain("cannot read");
  });
});
