// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SessionIdentity } from "../src/bundle.ts";
import { type ExecFn, runProcess } from "../src/exec.ts";
import type { Result } from "../src/result.ts";
import type { CheckResult } from "../src/runner.ts";
import { EvidenceService, resolveRepoRoot, summarize } from "../src/service.ts";

export const COMMAND = "evidence";
export const REPORT_MESSAGE = "evidence-report";

const SUBCOMMANDS = [
  "run",
  "status",
  "show",
  "verify",
  "config",
  "help",
] as const;

const HELP = [
  "/evidence run [id,id…]   exécute la recette (ou les contrôles listés), écrit .evidence/<id>.json, affiche le verdict",
  "/evidence status         dossiers de preuves existants",
  "/evidence show [id]      détail d'un dossier (défaut : le dernier)",
  "/evidence verify [id]    rejoue la recette et compare : reproduced | diverged | stale",
  "/evidence config         recette effective et critères",
  "Outils modèle : evidence_run, evidence_status",
].join("\n");

export interface ExtensionOverrides {
  readonly exec?: ExecFn;
  readonly now?: () => Date;
}

function identityOf(ctx: ExtensionContext): SessionIdentity {
  return {
    session_id: ctx.sessionManager.getSessionId(),
    provider: ctx.model?.provider ?? "unknown",
    model: ctx.model?.id ?? "unknown",
    thinking_level: ctx.thinkingLevel ?? null,
  };
}

export function createEvidenceExtension(overrides: ExtensionOverrides = {}) {
  return function evidence(pi: ExtensionAPI): void {
    const exec = overrides.exec ?? runProcess;

    async function serviceFor(
      ctx: ExtensionContext,
    ): Promise<Result<EvidenceService>> {
      const root = await resolveRepoRoot(exec, ctx.cwd);
      if (!root.ok) return root;
      return {
        ok: true,
        value: new EvidenceService({
          exec,
          repoRoot: root.value,
          now: overrides.now,
        }),
      };
    }

    function report(
      ctx: ExtensionContext,
      text: string,
      level: "info" | "error" = "info",
    ): void {
      pi.sendMessage(
        { customType: REPORT_MESSAGE, content: text, display: true },
        { triggerTurn: false },
      );
      if (ctx.hasUI && level === "error")
        ctx.ui.notify(text.split("\n")[0] ?? text, "error");
    }

    function progress(ctx: ExtensionContext): (result: CheckResult) => void {
      return (result) => {
        if (ctx.hasUI)
          ctx.ui.setStatus("evidence", `${result.id}: ${result.status}`);
      };
    }

    function clearProgress(ctx: ExtensionContext): void {
      if (ctx.hasUI) ctx.ui.setStatus("evidence", undefined);
    }

    async function handleCommand(
      args: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const parts = args
        .trim()
        .split(/\s+/)
        .filter((p) => p !== "");
      const head = parts[0] ?? "help";
      if (head === "help") return report(ctx, HELP);
      if (!(SUBCOMMANDS as readonly string[]).includes(head)) {
        return report(
          ctx,
          `evidence : sous-commande inconnue « ${head} »\n${HELP}`,
          "error",
        );
      }
      const resolved = await serviceFor(ctx);
      if (!resolved.ok)
        return report(ctx, `evidence : ${resolved.error}`, "error");
      const service = resolved.value;
      const emit = (result: Result<string>): void => {
        if (result.ok) report(ctx, result.value);
        else report(ctx, `evidence : ${result.error}`, "error");
      };
      switch (head) {
        case "status":
          return emit(await service.status());
        case "config":
          return emit(await service.describeRecipe());
        case "show":
          return emit(await service.show(parts[1]));
        case "run": {
          const only =
            parts[1] === undefined
              ? []
              : parts[1].split(",").filter((p) => p !== "");
          if (ctx.hasUI)
            ctx.ui.notify("evidence : exécution de la recette…", "info");
          const outcome = await service.run({
            only,
            session: identityOf(ctx),
            signal: ctx.signal,
            onProgress: progress(ctx),
          });
          clearProgress(ctx);
          if (!outcome.ok)
            return report(ctx, `evidence : ${outcome.error}`, "error");
          return report(
            ctx,
            `${summarize(outcome.value.bundle)}\ndossier : ${outcome.value.file}`,
            outcome.value.bundle.verdict === "failed" ? "error" : "info",
          );
        }
        case "verify": {
          if (ctx.hasUI)
            ctx.ui.notify("evidence : rejeu de la recette…", "info");
          const outcome = await service.verify(
            parts[1],
            identityOf(ctx),
            ctx.signal,
          );
          clearProgress(ctx);
          if (!outcome.ok)
            return report(ctx, `evidence : ${outcome.error}`, "error");
          const c = outcome.value.comparison;
          return report(
            ctx,
            `${c.outcome.toUpperCase()} — référence ${c.reference_id}, rejeu ${c.candidate_id}${c.differences.length === 0 ? "" : `\n- ${c.differences.join("\n- ")}`}`,
            c.outcome === "reproduced" ? "info" : "error",
          );
        }
        default:
          return;
      }
    }

    pi.registerCommand(COMMAND, {
      description:
        "Recette et preuves : /evidence run | status | show | verify | config | help",
      getArgumentCompletions: (prefix) => {
        const items = SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map(
          (s) => ({ value: s, label: s }),
        );
        return items.length === 0 ? null : items;
      },
      handler: handleCommand,
    });

    const asText = (result: Result<string>) => {
      if (!result.ok) throw new Error(result.error);
      return {
        content: [{ type: "text" as const, text: result.value }],
        details: { ok: true },
      };
    };

    pi.registerTool({
      name: "evidence_run",
      label: "Exécuter la recette de preuves",
      description:
        "Exécute les contrôles déclarés du dépôt courant (.evidence.json, sinon scripts découverts) et écrit un dossier de preuves lié à la révision et au modèle. Retourne le verdict : conformant | failed | incomplete | unverified. À appeler avant d'annoncer un travail terminé.",
      parameters: Type.Object({
        only: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Identifiants de contrôles à exécuter ; vide = toute la recette",
          }),
        ),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        const resolved = await serviceFor(ctx);
        if (!resolved.ok) throw new Error(resolved.error);
        const outcome = await resolved.value.run({
          only: params.only ?? [],
          session: identityOf(ctx),
          signal,
          onProgress: progress(ctx),
        });
        clearProgress(ctx);
        if (!outcome.ok) throw new Error(outcome.error);
        return {
          content: [
            {
              type: "text" as const,
              text: `${summarize(outcome.value.bundle)}\ndossier : ${outcome.value.file}`,
            },
          ],
          details: {
            id: outcome.value.bundle.id,
            verdict: outcome.value.bundle.verdict,
            file: outcome.value.file,
          },
        };
      },
    });

    pi.registerTool({
      name: "evidence_status",
      label: "État des preuves",
      description:
        "Liste les dossiers de preuves du dépôt courant, ou détaille un dossier donné.",
      parameters: Type.Object({
        id: Type.Optional(
          Type.String({ description: "Identifiant de dossier ; vide = liste" }),
        ),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const resolved = await serviceFor(ctx);
        if (!resolved.ok) throw new Error(resolved.error);
        return asText(
          params.id === undefined
            ? await resolved.value.status()
            : await resolved.value.show(params.id),
        );
      },
    });
  };
}

export default createEvidenceExtension();
