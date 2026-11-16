// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0
//
// Refuses any tracked file that names a private device, an internal identifier
// or a machine-local path: this package must stay autonomous.
//
// Exit codes: 0 no marker, 1 at least one marker, 2 the scan could not vouch
// for the tree (listing failed, a tracked file is unreadable, nothing read).

import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  openSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import { join } from "node:path";

const markers: readonly { family: string; pattern: RegExp }[] = [
  { family: "private-repository", pattern: /product-research/i },
  { family: "analysis-id", pattern: /\bDRL-\d{4}\b/ },
  { family: "private-tool", pattern: /\bdrill\b/i },
  { family: "campaign", pattern: /\bcampaign\b/i },
  { family: "machine-path", pattern: /\/Users\/[A-Za-z0-9._-]+\// },
  { family: "home-path", pattern: /\/home\/[A-Za-z0-9._-]+\// },
];

// Index modes of the entries that are not regular files.
const SYMLINK_MODE = "120000";
const GITLINK_MODE = "160000";

function cannotList(): never {
  console.error("cannot list tracked files");
  process.exit(2);
}

// The universe is the whole repository, not the subtree of the current
// directory: "tracked" on the volume line has to mean every tracked entry.
const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
});
const root = top.status === 0 ? top.stdout.replace(/\n$/, "") : "";
if (root === "") cannotList();
// --stage gives the mode git versions for each entry: a link or a submodule
// is told apart from the index, never from what the working tree holds.
const listing = spawnSync("git", ["ls-files", "-z", "--stage"], {
  cwd: root,
  encoding: "utf8",
});
if (listing.status !== 0) cannotList();
// One entry per path: an unmerged path appears once per stage.
const modes = new Map<string, string>();
for (const record of listing.stdout.split("\0")) {
  if (record === "") continue;
  const tab = record.indexOf("\t");
  const mode = record.slice(0, record.indexOf(" "));
  if (tab === -1 || mode === "") cannotList();
  modes.set(record.slice(tab + 1), mode);
}

function hits(text: string): string[] {
  return markers.filter((m) => m.pattern.test(text)).map((m) => m.family);
}

// O_NOFOLLOW: a regular tracked file that is a link in the working tree is
// not the content git versions, so it fails to open and counts as unreadable.
function readWithoutFollowing(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

let problems = 0;
let read = 0;
let unreadable = 0;
let exempted = 0;
let symlinks = 0;
let gitlinks = 0;
for (const [file, mode] of modes) {
  if (file.startsWith("LICENSES/") || file === "scripts/check-markers.ts") {
    exempted += 1;
    continue;
  }
  if (mode === GITLINK_MODE) {
    // A submodule is another repository: its content is not versioned here.
    gitlinks += 1;
    continue;
  }
  if (mode === SYMLINK_MODE) {
    // What git versions for a link is its target text: that text is scanned,
    // the file or directory behind it is never opened. A dangling link or a
    // link to a directory still has a target text, so it is not unreadable.
    let target: string;
    try {
      target = readlinkSync(join(root, file), "utf8");
    } catch {
      // No link in the working tree (deleted, or checked out as a file): its
      // target text was not scanned.
      console.error(`cannot read ${file}`);
      unreadable += 1;
      continue;
    }
    symlinks += 1;
    for (const family of hits(target)) {
      console.error(`${file}: link target: ${family}`);
      problems += 1;
    }
    continue;
  }
  let text: string;
  try {
    text = readWithoutFollowing(join(root, file));
  } catch {
    // A tracked file that cannot be read was not scanned: never a clean one.
    console.error(`cannot read ${file}`);
    unreadable += 1;
    continue;
  }
  read += 1;
  for (const [index, line] of text.split("\n").entries()) {
    for (const family of hits(line)) {
      console.error(`${file}:${index + 1}: ${family}`);
      problems += 1;
    }
  }
}
// read + unreadable + exempted + links + submodules = tracked: every tracked
// entry is accounted for in exactly one printed counter.
const volume = `${read} files read, ${unreadable} unreadable, ${exempted} exempted, ${symlinks} symbolic links not followed, ${gitlinks} submodule entries not scanned, ${modes.size} tracked, ${markers.length} marker families applied`;
if (unreadable > 0 || read === 0) {
  console.error(`markers not verified: ${volume}`);
  process.exit(2);
}
if (problems > 0) {
  console.error(`${problems} marker hit(s): ${volume}`);
  process.exit(1);
}
console.log(`no private marker in tracked files: ${volume}`);
