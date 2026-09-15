// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0
//
// Refuses any tracked file that names a private device, an internal identifier
// or a machine-local path: this package must stay autonomous.

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
let problems = 0;
for (const file of listing.stdout
  .split("\0")
  .filter((f) => f !== "" && !f.startsWith("LICENSES/"))) {
  const text = readFileSync(file, "utf8");
  for (const [index, line] of text.split("\n").entries()) {
    for (const marker of markers) {
      if (marker.pattern.test(line)) {
        console.error(`${file}:${index + 1}: ${marker.family}`);
        problems += 1;
      }
    }
  }
}
if (problems > 0) process.exit(1);
console.log("no private marker in tracked files");
