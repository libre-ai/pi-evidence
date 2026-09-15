// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { createScrubber, SCRUB_RULES, scrubText } from "../src/scrub.ts";

// Every secret below is synthetic: repeated filler characters that satisfy
// the length constraints without resembling any issued credential.
const FAKE = {
  ghp: `ghp_${"x".repeat(30)}`,
  ghs: `ghs_${"y".repeat(24)}`,
  githubPat: `github_pat_${"z".repeat(40)}`,
  bearer: `Bearer ${"b".repeat(24)}==`,
  aws: `AKIA${"A".repeat(16)}`,
  jwt: `eyJ${"h".repeat(12)}.${"p".repeat(12)}.${"s".repeat(12)}`,
  npm: `npm_${"n".repeat(36)}`,
  slack: `xoxb-${"1".repeat(10)}-${"k".repeat(12)}`,
  privateKey: [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEfakefakefakefakefakefake",
    "fakefakefakefakefakefakefake",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n"),
} as const;

function families(result: ReturnType<typeof scrubText>): string[] {
  return result.redactions.map((r) => r.family);
}

describe("SCRUB_RULES", () => {
  test("every rule is global and has a unique family", () => {
    const seen = new Set<string>();
    for (const rule of SCRUB_RULES) {
      expect(rule.pattern.global).toBe(true);
      expect(seen.has(rule.family)).toBe(false);
      seen.add(rule.family);
    }
  });
});

describe("scrubText", () => {
  test("redacts GitHub tokens (classic and fine-grained)", () => {
    const result = scrubText(`token ${FAKE.ghp} and ${FAKE.githubPat} here`);
    expect(result.text).toBe(
      "token [REDACTED:github-token] and [REDACTED:github-token] here",
    );
    expect(result.redactions).toEqual([{ family: "github-token", count: 2 }]);
    expect(scrubText(FAKE.ghs).text).toBe("[REDACTED:github-token]");
  });

  test("redacts Bearer tokens keeping the scheme word", () => {
    const result = scrubText(`Authorization: ${FAKE.bearer}\n`);
    expect(result.text).toBe("Authorization: Bearer [REDACTED:bearer-token]\n");
    expect(families(result)).toEqual(["bearer-token"]);
  });

  test("redacts AWS access key ids", () => {
    const result = scrubText(`aws ${FAKE.aws} end`);
    expect(result.text).toBe("aws [REDACTED:aws-access-key-id] end");
    expect(families(result)).toEqual(["aws-access-key-id"]);
  });

  test("redacts a multi-line private key block as one unit", () => {
    const result = scrubText(`before\n${FAKE.privateKey}\nafter\n`);
    expect(result.text).toBe("before\n[REDACTED:private-key]\nafter\n");
    expect(result.redactions).toEqual([{ family: "private-key", count: 1 }]);
    expect(scrubText("-----BEGIN PRIVATE KEY-----\nabc\n").text).toContain(
      "BEGIN",
    );
  });

  test("redacts only the value of credential assignments, any casing", () => {
    const input = [
      "api_key=abcdefghij",
      'PASSWORD: "hunter2hunter2"',
      "passwd = 'qwertyuiop'",
      "secret=short",
      "TOKEN:\tlongenoughvalue",
      "api-key=0123456789",
    ].join("\n");
    const result = scrubText(input);
    expect(result.text).toBe(
      [
        "api_key=[REDACTED:credential-assignment]",
        'PASSWORD: "[REDACTED:credential-assignment]"',
        "passwd = '[REDACTED:credential-assignment]'",
        "secret=short",
        "TOKEN:\t[REDACTED:credential-assignment]",
        "api-key=[REDACTED:credential-assignment]",
      ].join("\n"),
    );
    expect(result.redactions).toEqual([
      { family: "credential-assignment", count: 5 },
    ]);
  });

  test("does not double-redact a specific token sitting in an assignment", () => {
    const result = scrubText(`token=${FAKE.ghp}`);
    expect(result.text).toBe("token=[REDACTED:github-token]");
    expect(families(result)).toEqual(["github-token"]);
  });

  test("redacts JWT-like strings, including behind Bearer", () => {
    expect(scrubText(`jwt ${FAKE.jwt}`).text).toBe("jwt [REDACTED:jwt]");
    const result = scrubText(`Authorization: Bearer ${FAKE.jwt}`);
    expect(result.text).toBe("Authorization: Bearer [REDACTED:jwt]");
    expect(families(result)).toEqual(["jwt"]);
  });

  test("redacts npm and Slack tokens", () => {
    const result = scrubText(`${FAKE.npm}\n${FAKE.slack}\n`);
    expect(result.text).toBe("[REDACTED:npm-token]\n[REDACTED:slack-token]\n");
    expect(families(result)).toEqual(["npm-token", "slack-token"]);
  });

  test("leaves ordinary output untouched with no redactions", () => {
    const clean = "42 tests passed\nghp_short npm_x eyJ.a.b AKIA12\n";
    const result = scrubText(clean);
    expect(result.text).toBe(clean);
    expect(result.redactions).toEqual([]);
  });
});

describe("createScrubber", () => {
  test("redacts a token split across two chunks and matches scrubText", () => {
    const line = `log: found ${FAKE.ghp} in config\n`;
    const [head, tail] = [line.slice(0, 20), line.slice(20)];
    expect(head).toContain("ghp_");
    const scrubber = createScrubber();
    const out = scrubber.push(head) + scrubber.push(tail) + scrubber.flush();
    expect(out).toBe(scrubText(line).text);
    expect(out).toBe("log: found [REDACTED:github-token] in config\n");
    expect(scrubber.redactions()).toEqual(scrubText(line).redactions);
  });

  test("streams the same result as scrubText on the concatenation", () => {
    const lines: string[] = [];
    for (let i = 0; i < 40; i += 1) lines.push(`line ${i}: ${"a".repeat(30)}`);
    lines.push(`password=${"w".repeat(16)}`);
    lines.push(FAKE.privateKey);
    lines.push(`Authorization: ${FAKE.bearer}`);
    lines.push(`${FAKE.aws} ${FAKE.slack} ${FAKE.npm}`);
    for (let i = 0; i < 40; i += 1) lines.push(`tail ${i}`);
    const whole = `${lines.join("\n")}\n`;
    for (const size of [1, 7, 64, 255, 256, 257, 1000, whole.length + 1]) {
      const scrubber = createScrubber();
      let out = "";
      for (let at = 0; at < whole.length; at += size)
        out += scrubber.push(whole.slice(at, at + size));
      out += scrubber.flush();
      const expected = scrubText(whole);
      expect(out).toBe(expected.text);
      expect(scrubber.redactions()).toEqual(expected.redactions);
    }
  });

  test("holds back the trailing carry until flush", () => {
    const scrubber = createScrubber();
    expect(scrubber.push("short\n")).toBe("");
    // Only complete lines older than the carry leave the scrubber: the last
    // 256 characters (and the partial line they start in) wait for flush.
    const long = `${"x".repeat(300)}\n${"y".repeat(10)}`;
    expect(scrubber.push(long)).toBe("short\n");
    expect(scrubber.flush()).toBe(long);
    expect(scrubber.flush()).toBe("");
    expect(scrubber.redactions()).toEqual([]);
  });

  test("keeps an open private key block unflushed beyond the carry", () => {
    const scrubber = createScrubber();
    const opening = `${"z".repeat(400)}\n-----BEGIN PRIVATE KEY-----\n`;
    const body = `${"k".repeat(600)}\n`;
    const closing = "-----END PRIVATE KEY-----\ndone\n";
    let out = scrubber.push(opening);
    out += scrubber.push(body);
    expect(out).not.toContain("BEGIN");
    expect(out).not.toContain("kkkk");
    out += scrubber.push(closing);
    out += scrubber.flush();
    expect(out).toBe(`${"z".repeat(400)}\n[REDACTED:private-key]\ndone\n`);
    expect(scrubber.redactions()).toEqual([
      { family: "private-key", count: 1 },
    ]);
  });

  test("bounds memory when a stream has no line breaks", () => {
    const scrubber = createScrubber();
    const blob = "q".repeat(70_000);
    const emitted = scrubber.push(blob);
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted + scrubber.flush()).toBe(blob);
  });
});
