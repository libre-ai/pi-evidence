// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createEvidenceExtension,
  REMINDER_MESSAGE,
  REPORT_MESSAGE,
} from "../extensions/evidence.ts";
import { runProcess } from "../src/exec.ts";
import { gitRepo } from "./binding.test.ts";

type ToolEntry = {
  execute: (
    id: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ content: { text: string }[]; details?: unknown }>;
};

interface Captured {
  commands: Map<
    string,
    {
      handler: (args: string, ctx: unknown) => Promise<void>;
      getArgumentCompletions?: (p: string) => unknown;
    }
  >;
  tools: Map<string, ToolEntry>;
  events: Map<string, ((event: unknown, ctx: unknown) => unknown)[]>;
  messages: { customType: string; content: string }[];
  userMessages: string[];
  notifications: string[];
  statuses: (string | undefined)[];
  confirms: string[];
}

function fakePi(): { pi: ExtensionAPI; captured: Captured } {
  const captured: Captured = {
    commands: new Map(),
    tools: new Map(),
    events: new Map(),
    messages: [],
    userMessages: [],
    notifications: [],
    statuses: [],
    confirms: [],
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
    sendUserMessage: (content: string) => captured.userMessages.push(content),
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      captured.events.set(event, [
        ...(captured.events.get(event) ?? []),
        handler,
      ]);
    },
  } as unknown as ExtensionAPI;
  return { pi, captured };
}

function ctxFor(
  cwd: string,
  captured: Captured,
  options: { hasUI?: boolean; trusted?: boolean; confirm?: boolean } = {},
) {
  return {
    cwd,
    hasUI: options.hasUI ?? true,
    signal: undefined,
    model: { provider: "prov", id: "mod" },
    thinkingLevel: "low",
    isProjectTrusted: () => options.trusted ?? true,
    sessionManager: { getSessionId: () => "session-1" },
    ui: {
      notify: (m: string) => captured.notifications.push(m),
      setStatus: (_k: string, v: string | undefined) =>
        captured.statuses.push(v),
      confirm: async (_title: string, message: string) => {
        captured.confirms.push(message);
        return options.confirm ?? true;
      },
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

function declaredRepo(policy?: string): string {
  const dir = gitRepo();
  writeFileSync(
    join(dir, ".evidence.json"),
    JSON.stringify({
      schema_version: 1,
      ...(policy === undefined ? {} : { policy }),
      checks: [
        { id: "t", command: "sh", args: ["-c", "true"], required: true },
      ],
    }),
  );
  return dir;
}

describe("evidence extension", () => {
  test("registers one command, two tools and the session events", () => {
    const { captured, command } = install();
    expect([...captured.tools.keys()].sort()).toEqual([
      "evidence_run",
      "evidence_status",
    ]);
    expect([...captured.events.keys()].sort()).toEqual([
      "agent_end",
      "agent_start",
      "session_shutdown",
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
  });

  test("gates: untrusted project refused, unpinned recipe confirmed once, model tool never accepts", async () => {
    const { captured, command } = install();
    const dir = declaredRepo();
    await command.handler("run", ctxFor(dir, captured, { trusted: false }));
    expect(captured.messages.at(-1)?.content).toContain("projet non approuvé");
    await command.handler("run", ctxFor(dir, captured, { confirm: false }));
    expect(captured.messages.at(-1)?.content).toContain("recette refusée");
    expect(captured.confirms).toHaveLength(1);
    expect(captured.confirms[0]).toContain("jamais acceptée");
    await expect(
      captured.tools
        .get("evidence_run")
        ?.execute("c0", {}, undefined, undefined, ctxFor(dir, captured)),
    ).rejects.toThrow("accept");
    await command.handler("run --requirement TICKET-42", ctxFor(dir, captured));
    expect(captured.confirms).toHaveLength(2);
    expect(captured.messages.at(-1)?.content).toContain("CONFORMANT");
    await command.handler("config", ctxFor(dir, captured));
    expect(captured.messages.at(-1)?.content).toContain("épinglée");
    await command.handler("run", ctxFor(dir, captured));
    expect(captured.confirms).toHaveLength(2);
    const run = await captured.tools
      .get("evidence_run")
      ?.execute(
        "c1",
        { requirement: "TICKET-43" },
        undefined,
        undefined,
        ctxFor(dir, captured, { hasUI: false }),
      );
    const details = run?.details as { verdict: string; id: string } | undefined;
    expect(details?.verdict).toBe("conformant");
    const shown = await captured.tools
      .get("evidence_status")
      ?.execute(
        "c2",
        { id: details?.id ?? "" },
        undefined,
        undefined,
        ctxFor(dir, captured),
      );
    expect(shown?.content[0]?.text).toContain("CONFORMANT");
    await command.handler("run", ctxFor(dir, captured, { hasUI: false }));
    expect(captured.statuses.filter((s) => s !== undefined)).toEqual([
      "t: passed",
      "t: passed",
    ]);
    writeFileSync(
      join(dir, ".evidence.json"),
      JSON.stringify({
        schema_version: 1,
        checks: [
          { id: "t", command: "sh", args: ["-c", "false"], required: true },
        ],
      }),
    );
    await command.handler("run", ctxFor(dir, captured, { hasUI: false }));
    expect(captured.messages.at(-1)?.content).toContain("recette modifiée");
    await command.handler("accept", ctxFor(dir, captured));
    expect(captured.messages.at(-1)?.content).toContain(
      "acceptée par tui:session-1",
    );
    await command.handler("run", ctxFor(dir, captured, { hasUI: false }));
    expect(captured.messages.at(-1)?.content).toContain("FAILED");
    await command.handler("verify", ctxFor(dir, captured));
    expect(captured.messages.at(-1)?.content).toContain("REPRODUCED");
    await command.handler("verify nope", ctxFor(dir, captured));
    expect(captured.messages.at(-1)?.content).toContain("bundle not found");
    await command.handler("run t,zzz", ctxFor(dir, captured));
    expect(captured.messages.at(-1)?.content).toContain("unknown check");
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

  test("turn guard: reminds once per changed tree, stays silent when covered or off, demands when required", async () => {
    const { captured, command } = install();
    const dir = declaredRepo();
    const start = captured.events.get("agent_start")?.[0];
    const end = captured.events.get("agent_end")?.[0];
    const ctx = ctxFor(dir, captured);
    await start?.({}, ctx);
    await end?.({}, ctx);
    expect(
      captured.messages.filter((m) => m.customType === REMINDER_MESSAGE),
    ).toHaveLength(0);
    await start?.({}, ctx);
    writeFileSync(join(dir, "README.md"), "# changed by the turn\n");
    await end?.({}, ctx);
    expect(
      captured.messages.filter((m) => m.customType === REMINDER_MESSAGE),
    ).toHaveLength(1);
    await end?.({}, ctx);
    expect(
      captured.messages.filter((m) => m.customType === REMINDER_MESSAGE),
    ).toHaveLength(1);
    await start?.({}, ctx);
    writeFileSync(join(dir, "README.md"), "# changed again\n");
    await command.handler("run", ctx);
    await end?.({}, ctx);
    expect(
      captured.messages.filter((m) => m.customType === REMINDER_MESSAGE),
    ).toHaveLength(1);

    const off = declaredRepo("off");
    const offCtx = ctxFor(off, captured);
    await start?.({}, offCtx);
    writeFileSync(join(off, "README.md"), "# x\n");
    await end?.({}, offCtx);
    expect(
      captured.messages.filter((m) => m.customType === REMINDER_MESSAGE),
    ).toHaveLength(1);

    const required = declaredRepo("require");
    const reqCtx = ctxFor(required, captured);
    await start?.({}, reqCtx);
    writeFileSync(join(required, "README.md"), "# y\n");
    await end?.({}, reqCtx);
    expect(captured.userMessages).toHaveLength(1);
    expect(captured.userMessages[0]).toContain("evidence_run");
    await end?.({}, reqCtx);
    expect(captured.userMessages).toHaveLength(1);
    const shutdown = captured.events.get("session_shutdown")?.[0];
    shutdown?.({}, reqCtx);
    await end?.({}, ctxFor(mkdtempSync(join(tmpdir(), "x-")), captured));
  });
});
