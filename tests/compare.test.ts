// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { compareBundles } from "../src/compare.ts";
import { sampleBundle } from "./bundle.test.ts";

describe("compareBundles", () => {
  test("reproduced when tree, recipe and results match", () => {
    const c = compareBundles(sampleBundle("a"), sampleBundle("b"));
    expect(c.outcome).toBe("reproduced");
    expect(c.differences).toEqual([]);
  });

  test("stale when the tree or the recipe differ", () => {
    const reference = sampleBundle("a");
    const moved = {
      ...sampleBundle("b"),
      revision: { ...reference.revision, head: "f".repeat(40) },
    };
    expect(compareBundles(reference, moved).outcome).toBe("stale");
    const edited = {
      ...sampleBundle("b"),
      revision: { ...reference.revision, diff_sha256: "9".repeat(64) },
    };
    expect(compareBundles(reference, edited).differences).toEqual([
      "working tree diff differs",
    ]);
    const otherRecipe = {
      ...sampleBundle("b"),
      recipe: { ...reference.recipe, hash: "8".repeat(64) },
    };
    expect(compareBundles(reference, otherRecipe).differences).toEqual([
      "recipe differs",
    ]);
  });

  test("diverged when a check changes status or is missing", () => {
    const reference = sampleBundle("a");
    const candidate = sampleBundle("b");
    const failing = {
      ...candidate,
      verdict: "failed" as const,
      results: [
        { ...candidate.results[0], status: "failed" as const, exit_code: 1 },
      ],
    } as typeof candidate;
    const c = compareBundles(reference, failing);
    expect(c.outcome).toBe("diverged");
    expect(c.differences).toEqual([
      "t: passed (exit 0) → failed (exit 1)",
      "verdict conformant → failed",
    ]);
    const extra = {
      ...candidate,
      results: [...candidate.results, { ...candidate.results[0], id: "u" }],
    } as typeof candidate;
    expect(compareBundles(reference, extra).differences).toEqual([
      "u: not in reference",
    ]);
    const missing = { ...candidate, results: [] } as typeof candidate;
    expect(compareBundles(reference, missing).differences).toEqual([
      "t: not re-run",
    ]);
  });
});
