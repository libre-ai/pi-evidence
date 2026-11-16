// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0
//
// Refuses any tracked file that names a private device, an internal identifier
// or a machine-local path: this package must stay autonomous.
//
// Exit codes: 0 no marker, 1 at least one marker, 2 the scan could not vouch
// for the tree (listing failed, a tracked file is unreadable, nothing read).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const markers: readonly { family: string; pattern: RegExp }[] = [
  { family: "private-repository", pattern: /product-research/i },
  { family: "analysis-id", pattern: /\bDRL-\d{4}\b/ },
  { family: "private-tool", pattern: /\bdrill\b/i },
  { family: "campaign", pattern: /\bcampaign\b/i },
  { family: "machine-path", pattern: /\/Users\/[A-Za-z0-9._-]+\// },
  { family: "home-path", pattern: /\/home\/[A-Za-z0-9._-]+\// },
];

const listing = spawnSync("git", ["ls-files", "-z"], { encoding: "utf8" });
if (listing.status !== 0) {
  console.error("cannot list tracked files");
  process.exit(2);
}
const tracked = listing.stdout.split("\0").filter((f) => f !== "");
const scanned = tracked.filter(
  (f) => !f.startsWith("LICENSES/") && f !== "scripts/check-markers.ts",
);
let problems = 0;
let unreadable = 0;
for (const file of scanned) {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    // A tracked file that cannot be read was not scanned: never a clean one.
    console.error(`cannot read ${file}`);
    unreadable += 1;
    continue;
  }
  for (const [index, line] of text.split("\n").entries()) {
    for (const marker of markers) {
      if (marker.pattern.test(line)) {
        console.error(`${file}:${index + 1}: ${marker.family}`);
        problems += 1;
      }
    }
  }
}
// read + unreadable + exempted = tracked: every tracked entry is accounted for.
const read = scanned.length - unreadable;
const volume = `${read} files read, ${unreadable} unreadable, ${tracked.length - scanned.length} exempted, ${tracked.length} tracked, ${markers.length} marker families applied`;
if (unreadable > 0 || read === 0) {
  console.error(`markers not verified: ${volume}`);
  process.exit(2);
}
if (problems > 0) {
  console.error(`${problems} marker hit(s): ${volume}`);
  process.exit(1);
}
console.log(`no private marker in tracked files: ${volume}`);
