// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createEvidenceExtension,
  REPORT_MESSAGE,
} from "../extensions/evidence.ts";
import { runProcess } from "../src/exec.ts";
import { gitRepo } from "./binding.test.ts";

type ToolEntry = Captured["tools"] extends Map<string, infer V> ? V : never;

interface Captured {
  commands: Map<
    string,
    {
      handler: (args: string, ctx: unknown) => Promise<void>;
      getArgumentCompletions?: (p: string) => unknown;
    }
  >;
  tools: Map<
    string,
    {
      execute: (
        id: string,
        params: unknown,
        signal: undefined,
        onUpdate: undefined,
        ctx: unknown,
      ) => Promise<{ content: { text: string }[]; details?: unknown }>;
    }
  >;
  messages: { customType: string; content: string }[];
  notifications: string[];
  statuses: (string | undefined)[];
}

function fakePi(): { pi: ExtensionAPI; captured: Captured } {
  const captured: Captured = {
    commands: new Map(),
    tools: new Map(),
    messages: [],
    notifications: [],
    statuses: [],
  };
  const pi = {
    registerCommand: (name: string, options: never) => {
      if (captured.commands.has(name)) throw new Error("duplicate");
      captured.commands.set(name, options);
    },
    registerTool: (tool: { name: string }) => {
      if (captured.tools.has(tool.name)) throw new Error("duplicate");
      captured.tools.set(tool.name, tool as unknown as ToolEntry);
    },
    sendMessage: (message: { customType: string; content: string }) =>
      captured.messages.push(message),
    on: () => undefined,
  } as unknown as ExtensionAPI;
  return { pi, captured };
}

function ctxFor(cwd: string, captured: Captured, hasUI = true) {
  return {
    cwd,
    hasUI,
    signal: undefined,
    model: { provider: "prov", id: "mod" },
    thinkingLevel: "low",
    sessionManager: { getSessionId: () => "session-1" },
    ui: {
      notify: (m: string) => captured.notifications.push(m),
      setStatus: (_k: string, v: string | undefined) =>
        captured.statuses.push(v),
    },
  };
}

function install() {
  const { pi, captured } = fakePi();
  createEvidenceExtension({
    exec: runProcess,
    now: () => new Date("2026-09-15T12:00:00Z"),
  })(pi);
  const command = captured.commands.get("evidence");
  if (command === undefined) throw new Error("command missing");
  return { captured, command };
}

describe("evidence extension", () => {
  test("registers one command and two tools", () => {
    const { captured, command } = install();
    expect([...captured.tools.keys()].sort()).toEqual([
      "evidence_run",
      "evidence_status",
    ]);
    expect(command.getArgumentCompletions?.("ve")).toEqual([
      { value: "verify", label: "verify" },
    ]);
    expect(command.getArgumentCompletions?.("zz")).toBeNull();
  });

  test("help, unknown subcommand and non-git directory are reported", async () => {
    const { captured, command } = install();
    const plain = mkdtempSync(join(tmpdir(), "evidence-ext-plain-"));
    await command.handler("", ctxFor(plain, captured));
    expect(captured.messages[0]?.customType).toBe(REPORT_MESSAGE);
    expect(captured.messages[0]?.content).toContain("/evidence run");
    await command.handler("bogus", ctxFor(plain, captured));
    expect(captured.messages[1]?.content).toContain("inconnue");
    await command.handler("status", ctxFor(plain, captured));
    expect(captured.messages[2]?.content).toContain("not a git repository");
    expect(captured.notifications).toHaveLength(2);
  });

  test("runs, shows, verifies and exposes the same logic through tools", async () => {
    const { captured, command } = install();
    const dir = gitRepo();
    writeFileSync(
      join(dir, ".evidence.json"),
      JSON.stringify({
        schema_version: 1,
        checks: [
          { id: "t", command: "sh", args: ["-c", "true"], required: true },
        ],
      }),
    );
    const ctx = ctxFor(join(dir), captured);
    await command.handler("config", ctx);
    expect(captured.messages.at(-1)?.content).toContain(
      "critères déclarés : oui",
    );
    await command.handler("run", ctx);
    expect(captured.messages.at(-1)?.content).toContain("CONFORMANT");
    expect(captured.statuses).toEqual(["t: passed", undefined]);
    await command.handler("status", ctx);
    expect(captured.messages.at(-1)?.content).toContain("conformant");
    await command.handler("show", ctx);
    expect(captured.messages.at(-1)?.content).toContain("session-1");
    await command.handler("verify", ctx);
    expect(captured.messages.at(-1)?.content).toContain("REPRODUCED");
    await command.handler("run t,zzz", ctx);
    expect(captured.messages.at(-1)?.content).toContain("unknown check");
    await command.handler("verify nope", ctx);
    expect(captured.messages.at(-1)?.content).toContain("bundle not found");

    const run = await captured.tools
      .get("evidence_run")
      ?.execute("c1", {}, undefined, undefined, ctxFor(dir, captured, false));
    expect(run?.content[0]?.text).toContain("CONFORMANT");
    const runDetails = run?.details as
      | { verdict: string; id: string }
      | undefined;
    expect(runDetails?.verdict).toBe("conformant");
    const status = await captured.tools
      .get("evidence_status")
      ?.execute("c2", {}, undefined, undefined, ctx);
    expect(status?.content[0]?.text.split("\n").length).toBeGreaterThanOrEqual(
      3,
    );
    const detail = await captured.tools
      .get("evidence_status")
      ?.execute("c3", { id: runDetails?.id ?? "" }, undefined, undefined, ctx);
    expect(detail?.content[0]?.text).toContain("CONFORMANT");
    await expect(
      captured.tools
        .get("evidence_run")
        ?.execute("c4", { only: ["zzz"] }, undefined, undefined, ctx),
    ).rejects.toThrow("unknown check");
    await expect(
      captured.tools
        .get("evidence_status")
        ?.execute(
          "c5",
          {},
          undefined,
          undefined,
          ctxFor(mkdtempSync(join(tmpdir(), "x-")), captured),
        ),
    ).rejects.toThrow("not a git");
  });
});
