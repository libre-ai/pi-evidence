// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { bindRevision } from "../src/binding.ts";
import type { SessionIdentity } from "../src/bundle.ts";
import { type ExecFn, runProcess } from "../src/exec.ts";
import { resolveRecipe } from "../src/recipe.ts";
import type { Result } from "../src/result.ts";
import type { CheckResult } from "../src/runner.ts";
import { EvidenceService, resolveRepoRoot, summarize } from "../src/service.ts";

export const COMMAND = "evidence";
export const REPORT_MESSAGE = "evidence-report";
export const REMINDER_MESSAGE = "evidence-reminder";

const SUBCOMMANDS = [
  "run",
  "status",
  "show",
  "verify",
  "config",
  "accept",
  "help",
] as const;

const HELP = [
  "/evidence run [id,id…] [--requirement <réf>] [--base <réf>]   exécute la recette (différentiel si --base), écrit .evidence/<id>.json, affiche le verdict",
  "/evidence status         dossiers de preuves existants",
  "/evidence show [id]      détail d'un dossier (défaut : le dernier)",
  "/evidence verify [id]    rejoue la recette et compare : reproduced | diverged | stale",
  "/evidence config         recette effective, critères, état d'épinglage",
  "/evidence accept         accepte la recette courante (première exécution ou recette modifiée)",
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

function parseRunArgs(parts: readonly string[]): {
  only: string[];
  requirement: string | null;
  baseRef: string | null;
} {
  let requirement: string | null = null;
  let baseRef: string | null = null;
  const rest: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) continue;
    if (part === "--base") {
      baseRef = parts[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (part === "--requirement") {
      requirement = parts[index + 1] ?? null;
      index += 1;
      continue;
    }
    rest.push(part);
  }
  const only =
    rest[0] === undefined ? [] : rest[0].split(",").filter((p) => p !== "");
  return { only, requirement, baseRef };
}

export function createEvidenceExtension(overrides: ExtensionOverrides = {}) {
  return function evidence(pi: ExtensionAPI): void {
    const exec = overrides.exec ?? runProcess;
    // Tree fingerprint at the start of the current turn, and the fingerprints
    // already reminded about, so the guard never nags twice for one state.
    let turnStartFingerprint: string | null = null;
    const remindedFingerprints = new Set<string>();

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

    // Executing a recipe executes repository code. Two gates, both enforced in
    // code: Pi's project trust, and an explicit acceptance of the exact recipe.
    async function gate(
      service: EvidenceService,
      ctx: ExtensionContext,
      interactive: boolean,
    ): Promise<Result<{ acceptRecipe: { by: string } | undefined }>> {
      if (!ctx.isProjectTrusted()) {
        return {
          ok: false,
          error:
            "projet non approuvé : la recette exécute le code de ce dépôt ; utiliser /trust puis réessayer",
        };
      }
      const pin = await service.pinStatus();
      if (!pin.ok) return pin;
      if (pin.value.state.state === "pinned")
        return { ok: true, value: { acceptRecipe: undefined } };
      if (!interactive || !ctx.hasUI) {
        return {
          ok: false,
          error: `${pin.value.text} ; lancer /evidence accept ou /evidence config pour l'examiner`,
        };
      }
      const confirmed = await ctx.ui.confirm(
        "Recette de preuves",
        `${pin.value.text}\n\nExécuter cette recette ? Chaque commande tourne avec vos droits.`,
      );
      if (!confirmed) return { ok: false, error: "recette refusée" };
      return {
        ok: true,
        value: {
          acceptRecipe: { by: `tui:${ctx.sessionManager.getSessionId()}` },
        },
      };
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
        case "config": {
          const recipe = await service.describeRecipe();
          const pin = await service.pinStatus();
          if (!recipe.ok) return emit(recipe);
          return report(
            ctx,
            `${recipe.value}\n${pin.ok ? pin.value.text : pin.error}`,
          );
        }
        case "show":
          return emit(await service.show(parts[1]));
        case "accept":
          return emit(
            await service.acceptCurrentRecipe(
              `tui:${ctx.sessionManager.getSessionId()}`,
            ),
          );
        case "run": {
          const { only, requirement, baseRef } = parseRunArgs(parts.slice(1));
          const gated = await gate(service, ctx, true);
          if (!gated.ok)
            return report(ctx, `evidence : ${gated.error}`, "error");
          if (ctx.hasUI)
            ctx.ui.notify("evidence : exécution de la recette…", "info");
          const outcome = await service.run({
            only,
            requirement,
            baseRef,
            session: identityOf(ctx),
            signal: ctx.signal,
            onProgress: progress(ctx),
            acceptRecipe: gated.value.acceptRecipe,
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
          const gated = await gate(service, ctx, true);
          if (!gated.ok)
            return report(ctx, `evidence : ${gated.error}`, "error");
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
        "Recette et preuves : /evidence run | status | show | verify | config | accept | help",
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
        "Exécute les contrôles déclarés du dépôt courant (.evidence.json, sinon scripts découverts) et écrit un dossier de preuves lié à la révision et au modèle. Retourne le verdict : conformant | failed | incomplete | unverified. Refuse si le projet n'est pas approuvé ou si la recette n'a pas été acceptée par une personne. À appeler avant d'annoncer un travail terminé.",
      parameters: Type.Object({
        only: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Identifiants de contrôles à exécuter ; vide = toute la recette",
          }),
        ),
        base_ref: Type.Optional(
          Type.String({
            description:
              "Révision de base pour un différentiel (régression vs dette préexistante)",
          }),
        ),
        requirement: Type.Optional(
          Type.String({
            description: "Référence de l'exigence traitée (ticket, critère)",
          }),
        ),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        const resolved = await serviceFor(ctx);
        if (!resolved.ok) throw new Error(resolved.error);
        // The model never gets to accept a recipe: that decision stays human.
        const gated = await gate(resolved.value, ctx, false);
        if (!gated.ok) throw new Error(gated.error);
        const outcome = await resolved.value.run({
          only: params.only ?? [],
          requirement: params.requirement ?? null,
          baseRef: params.base_ref ?? null,
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

    async function fingerprint(
      ctx: ExtensionContext,
    ): Promise<{ root: string; value: string } | null> {
      const root = await resolveRepoRoot(exec, ctx.cwd);
      if (!root.ok) return null;
      const recipe = await resolveRecipe(root.value);
      const excluded = recipe.ok ? [recipe.value.output_dir] : [".evidence"];
      const revision = await bindRevision(exec, root.value, excluded);
      if (!revision.ok) return null;
      return {
        root: root.value,
        value: `${revision.value.head}:${revision.value.diff_sha256}:${revision.value.status_sha256}`,
      };
    }

    pi.on("agent_start", async (_event, ctx) => {
      const current = await fingerprint(ctx);
      turnStartFingerprint = current?.value ?? null;
    });

    // The guard is an executed check, not a prompt: if the turn changed the
    // tree and no bundle matches that exact tree, say so (or demand it).
    pi.on("agent_end", async (_event, ctx) => {
      const current = await fingerprint(ctx);
      if (current === null || turnStartFingerprint === null) return;
      if (current.value === turnStartFingerprint) return;
      if (remindedFingerprints.has(current.value)) return;
      const recipe = await resolveRecipe(current.root);
      const policy = recipe.ok ? recipe.value.policy : "remind";
      if (policy === "off") return;
      const service = new EvidenceService({
        exec,
        repoRoot: current.root,
        now: overrides.now,
      });
      const latest = await service.load();
      const [head, diff, status] = current.value.split(":");
      const covered =
        latest.ok &&
        latest.value.revision.head === head &&
        latest.value.revision.diff_sha256 === diff &&
        latest.value.revision.status_sha256 === status;
      if (covered) return;
      remindedFingerprints.add(current.value);
      if (policy === "require") {
        pi.sendUserMessage(
          "L'arbre de travail a changé pendant ce tour et aucun dossier de preuves ne correspond à son état. Appelle l'outil evidence_run maintenant, puis rends compte du verdict.",
          { deliverAs: "followUp" },
        );
        return;
      }
      pi.sendMessage(
        {
          customType: REMINDER_MESSAGE,
          content:
            "evidence : l'arbre a changé pendant ce tour et aucun dossier de preuves ne correspond à cet état (/evidence run ou evidence_run).",
          display: true,
        },
        { triggerTurn: false },
      );
    });

    pi.on("session_shutdown", () => {
      turnStartFingerprint = null;
      remindedFingerprints.clear();
    });
  };
}

export default createEvidenceExtension();
