// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

// Check output is persisted verbatim in log files and quoted in bundles that
// may be committed or attached to a PR: a token printed by a misconfigured
// tool must never reach disk. Hashes are computed on the raw stream by the
// runner; only the persisted text goes through these rules.

export interface ScrubRule {
  readonly family: string;
  readonly pattern: RegExp;
}

// Order matters: specific families run before the generic assignment rule so
// `token=ghp_...` is attributed to `github-token`, and the JWT rule runs
// before `bearer-token` so a bearer JWT keeps its more precise family.
export const SCRUB_RULES: readonly ScrubRule[] = [
  {
    family: "private-key",
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    family: "jwt",
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    family: "github-token",
    pattern: /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  },
  { family: "npm-token", pattern: /npm_[A-Za-z0-9]{36}/g },
  { family: "slack-token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { family: "aws-access-key-id", pattern: /AKIA[0-9A-Z]{16}/g },
  {
    family: "bearer-token",
    pattern: /(?<=Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/g,
  },
  {
    // The key name stays visible (it tells the reader what leaked) and only
    // the value is replaced. A value that is already a placeholder is left
    // alone so a specific family is not overwritten by the generic one.
    family: "credential-assignment",
    pattern:
      /(?<=(?:api[_-]?key|password|passwd|secret|token)\s*[:=]\s*['"]?)(?!\[REDACTED:)[^\s'"]{6,}/gi,
  },
];

export interface Redaction {
  readonly family: string;
  readonly count: number;
}

export interface ScrubResult {
  readonly text: string;
  readonly redactions: readonly Redaction[];
}

function placeholder(family: string): string {
  return `[REDACTED:${family}]`;
}

export function scrubText(text: string): ScrubResult {
  let current = text;
  const redactions: Redaction[] = [];
  for (const rule of SCRUB_RULES) {
    let count = 0;
    current = current.replace(rule.pattern, () => {
      count += 1;
      return placeholder(rule.family);
    });
    if (count > 0) redactions.push({ family: rule.family, count });
  }
  return { text: current, redactions };
}

export interface Scrubber {
  push(chunk: string): string;
  flush(): string;
  redactions(): readonly Redaction[];
}

// Characters kept unflushed after every push: a secret can straddle two
// chunks, and a match is only visible once both halves are in one string.
const CARRY_CHARACTERS = 256;
// Upper bound on held text, so an output with no line breaks (or a BEGIN
// marker never followed by END) cannot grow memory without limit.
const MAX_HOLD_CHARACTERS = 64 * 1024;
const BEGIN_MARKER = "-----BEGIN ";
const END_MARKER = /-----END [A-Z ]*PRIVATE KEY-----/g;

// Trade-off of the streaming form: text is scrubbed in slices, so a match
// crossing a slice boundary would be missed. Slices end at a line break at
// least CARRY_CHARACTERS before the end of the buffer, which keeps every
// single-line family whole; a private key block is held from its BEGIN line
// until its END line arrives. What is given up: a private key longer than
// MAX_HOLD_CHARACTERS, or an assignment value spanning a line break, may be
// emitted partially scrubbed. `scrubText` on the whole output has no such gap;
// the runner uses the streaming form because it must not buffer full logs.
export function createScrubber(): Scrubber {
  let pending = "";
  const counts = new Map<string, number>();

  const record = (redactions: readonly Redaction[]): void => {
    for (const { family, count } of redactions)
      counts.set(family, (counts.get(family) ?? 0) + count);
  };

  const emit = (upTo: number): string => {
    if (upTo <= 0) return "";
    const head = pending.slice(0, upTo);
    pending = pending.slice(upTo);
    const scrubbed = scrubText(head);
    record(scrubbed.redactions);
    return scrubbed.text;
  };

  // A key block that starts before `cut` and ends after it (or has not ended
  // yet) would be split by the line-break cut, so the cut moves back to its
  // BEGIN marker; the whole block is then scrubbed once its END has arrived.
  const keepKeyBlockWhole = (cut: number): number => {
    const begin = pending.lastIndexOf(BEGIN_MARKER, cut - 1);
    if (begin === -1 || pending.length - begin > MAX_HOLD_CHARACTERS)
      return cut;
    END_MARKER.lastIndex = begin;
    const end = END_MARKER.exec(pending);
    END_MARKER.lastIndex = 0;
    const blockEnd = end === null ? Infinity : end.index + end[0].length;
    return blockEnd <= cut ? cut : begin;
  };

  return {
    push(chunk) {
      pending += chunk;
      const limit = pending.length - CARRY_CHARACTERS;
      if (limit <= 0) return "";
      const lineBreak = Math.max(
        pending.lastIndexOf("\n", limit - 1),
        pending.lastIndexOf("\r", limit - 1),
      );
      let cut = lineBreak + 1;
      if (cut === 0) {
        // No line break to cut at: hold everything while it stays bounded,
        // otherwise cut inside the line rather than grow without limit.
        if (pending.length <= MAX_HOLD_CHARACTERS) return "";
        cut = limit;
      }
      return emit(keepKeyBlockWhole(cut));
    },
    flush() {
      return emit(pending.length);
    },
    redactions() {
      return SCRUB_RULES.flatMap((rule) => {
        const count = counts.get(rule.family);
        return count === undefined ? [] : [{ family: rule.family, count }];
      });
    },
  };
}
