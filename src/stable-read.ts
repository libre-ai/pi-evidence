// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { fail, ok, type Result } from "./result.ts";

// A digest only attests a file if the bytes hashed are the bytes of one
// version of that file. A path can be a symbolic link, be replaced by a
// rename, or be rewritten while it is read; each of these turns a recorded
// sha256 into a claim about content nobody kept. The read is therefore
// refused whenever the identity or version of the file moves between its
// inspection, its opening, the end of the read and a final inspection.
//
// Method adapted from `readStableArtifact` in morluto/rea (MIT).
//
// Limit: a same-size in-place rewrite landing within the file system's
// timestamp granularity is invisible to metadata. Callers that store the
// content must store the returned bytes, never re-read the path.

export interface StableRead {
  readonly bytes: Buffer;
  readonly sha256: string;
}

export interface StableReadHandle {
  stat(): Promise<BigIntStats>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }>;
  close(): Promise<void>;
}

// The seam lets tests change the file at a precise step of the read.
export interface StableReadFs {
  lstat(path: string): Promise<BigIntStats>;
  open(path: string, flags: number): Promise<StableReadHandle>;
}

export const NODE_STABLE_READ_FS: StableReadFs = {
  lstat: (path) => lstat(path, { bigint: true }),
  async open(path, flags) {
    const handle = await open(path, flags);
    return {
      stat: () => handle.stat({ bigint: true }),
      read: (buffer, offset, length, position) =>
        handle.read(buffer, offset, length, position),
      close: () => handle.close(),
    };
  },
};

// O_NOFOLLOW closes the window between the lstat and the open: a symbolic
// link planted there makes the open fail instead of being followed.
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;

function sameVersion(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export async function readStableFile(
  path: string,
  maximumBytes: number,
  fileSystem: StableReadFs = NODE_STABLE_READ_FS,
): Promise<Result<StableRead>> {
  let inspected: BigIntStats;
  try {
    inspected = await fileSystem.lstat(path);
  } catch {
    return fail(`cannot read ${path}`);
  }
  if (inspected.isSymbolicLink() || !inspected.isFile()) {
    return fail(`${path} is not a regular file`);
  }
  if (inspected.size > BigInt(maximumBytes)) {
    return fail(`${path} exceeds ${maximumBytes} bytes`);
  }

  let handle: StableReadHandle;
  try {
    handle = await fileSystem.open(path, READ_FLAGS);
  } catch {
    return fail(`cannot read ${path}`);
  }
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (!sameVersion(inspected, opened)) {
      return fail(`${path} changed before it was read`);
    }
    const size = Number(opened.size);
    // One byte past the expected size: a file that grows is detected by the
    // read itself, not only by metadata.
    const buffer = Buffer.alloc(size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        total,
        buffer.length - total,
        total,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    const finished = await handle.stat();
    if (total !== size || !sameVersion(opened, finished)) {
      return fail(`${path} changed while it was read`);
    }
    bytes = buffer.subarray(0, size);
  } catch {
    return fail(`cannot read ${path}`);
  } finally {
    await handle.close();
  }

  let current: BigIntStats;
  try {
    current = await fileSystem.lstat(path);
  } catch {
    return fail(`${path} was replaced while it was read`);
  }
  if (!sameVersion(inspected, current)) {
    return fail(`${path} was replaced while it was read`);
  }
  return ok({
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
