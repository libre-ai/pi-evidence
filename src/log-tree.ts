// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fail, ok, type Result } from "./result.ts";

// Copy of a log directory for `evidence publish-logs`. The tree is listed
// before anything is written, and each file is copied only if the file opened
// at copy time is the very file that was listed (same device and inode).
//
// Why the identity and not the path: between the listing and the copy, an
// intermediate directory of the source can be replaced by a symbolic link.
// O_NOFOLLOW and lstat only guard the last component, so the path would then
// lead outside the checked tree. A file reached through such a link is a
// different inode, and the copy refuses it.
//
// The listing has the same hazard, since readdir follows a link on any
// component: each directory is inspected (lstat) before and after it is read.
//
// Limits, Node offering no openat: a directory swapped for a link and back
// within one readdir is not seen; an inode freed and reused on the same
// device during the copy passes the identity check. Content rewritten in
// place is copied as read.

interface Identity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface ListedFile extends Identity {
  readonly path: string;
}

export interface LogTree {
  // Relative paths; a directory always precedes what it contains.
  readonly directories: readonly string[];
  readonly files: readonly ListedFile[];
}

// A symbolic link, or any entry that is neither a regular file nor a
// directory, refuses the whole tree: a link would publish content from
// outside the directory that was checked.
export async function listLogTree(root: string): Promise<Result<LogTree>> {
  const directories: string[] = [];
  const files: ListedFile[] = [];
  const pending: string[] = [""];
  try {
    if (!(await lstat(root)).isDirectory())
      return fail(`${root} is not a directory`);
    for (
      let relative = pending.pop();
      relative !== undefined;
      relative = pending.pop()
    ) {
      const directory = join(root, relative);
      // readdir follows a link on any component: the directory must be the
      // same real directory before and after it is read.
      const before = await lstat(directory, { bigint: true });
      const entries = await readdir(directory, { withFileTypes: true });
      const after = await lstat(directory, { bigint: true });
      if (
        !before.isDirectory() ||
        !after.isDirectory() ||
        before.dev !== after.dev ||
        before.ino !== after.ino
      )
        return fail(`${directory} changed while it was listed`);
      for (const entry of entries) {
        const child = join(relative, entry.name);
        if (entry.isDirectory()) {
          directories.push(child);
          pending.push(child);
          continue;
        }
        const stats = await lstat(join(root, child), { bigint: true });
        if (!stats.isFile())
          return fail(
            `${join(root, child)} is not a regular file or a directory`,
          );
        files.push({ path: child, dev: stats.dev, ino: stats.ino });
      }
    }
  } catch {
    return fail(`cannot read ${root}`);
  }
  return ok({ directories, files });
}

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;

async function readListedFile(
  path: string,
  listed: Identity,
): Promise<Result<Buffer>> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, READ_FLAGS);
  } catch {
    return fail(`cannot read ${path}`);
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== listed.dev ||
      opened.ino !== listed.ino
    )
      return fail(`${path} is not the file that was listed`);
    return ok(await handle.readFile());
  } catch {
    return fail(`cannot read ${path}`);
  } finally {
    await handle.close();
  }
}

async function writeLogTree(
  from: string,
  to: string,
  tree: LogTree,
): Promise<Result<number>> {
  try {
    for (const directory of tree.directories) await mkdir(join(to, directory));
    for (const file of tree.files) {
      const read = await readListedFile(join(from, file.path), file);
      if (!read.ok) return read;
      await writeFile(join(to, file.path), read.value, { flag: "wx" });
    }
  } catch {
    return fail(`cannot write under ${to}`);
  }
  return ok(tree.files.length);
}

// The destination exists only when the copy is complete. It is created here,
// without its parents and never over an existing path, so the removal on
// failure only ever deletes what this call created. `afterListing` is a test
// seam: it runs between the listing and the first write.
export async function copyLogTree(
  from: string,
  to: string,
  afterListing: () => Promise<void> = async () => {},
): Promise<Result<number>> {
  const tree = await listLogTree(from);
  if (!tree.ok) return tree;
  await afterListing();
  try {
    await mkdir(to);
  } catch {
    return fail(`cannot create ${to}`);
  }
  const written = await writeLogTree(from, to, tree.value);
  if (!written.ok) await rm(to, { recursive: true, force: true });
  return written;
}
