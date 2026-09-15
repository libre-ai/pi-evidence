// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { summarizeAcceptance } from "./acceptance.ts";
import type { SessionIdentity } from "./bundle.ts";
import { runProcess } from "./exec.ts";
import type { Result } from "./result.ts";
import { EvidenceService, resolveRepoRoot, summarize } from "./service.ts";

export const USAGE = [
  "evidence <command> [options]",
  "",
  "  run       [--only a,b] [--requirement REF] [--base REF] [--accept-recipe --by NAME]",
  "  gate      same as run; exit 0 only when the verdict is conformant",
  "  verify    [ID] [--require-reproduced] [--if-present] | --ci (evidence-only commit protocol)",
  "  compare   --base REF (run with a base/candidate differential)",
  "  status | show [ID] | config",
  "  accept    --by NAME              accept the current recipe (pin it)",
  "  init      [--force]              write .evidence.json from discovery",
  "  attach    [ID] --kind verify-runtime|report --file PATH",
  "  decide    [ID] --by NAME --decision accepted|rejected [--note TEXT]",
  "  prune     --keep N [--dry-run]",
  "",
  "Global: --json (machine output), --cwd DIR. Session identity: EVIDENCE_SESSION_ID,",
  "EVIDENCE_PROVIDER, EVIDENCE_MODEL (defaults: cli:<pid>, cli, none).",
  "Signing: EVIDENCE_SSH_KEY or git gpg.format=ssh + user.signingkey; verification: EVIDENCE_ALLOWED_SIGNERS.",
].join("\n");

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

interface Parsed {
  readonly command: string;
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | true>>;
}

// Flags that never take a value: a positional after them stays positional.
const BOOLEAN_FLAGS = new Set([
  "json",
  "accept-recipe",
  "require-reproduced",
  "if-present",
  "ci",
  "force",
  "dry-run",
  "help",
]);

export function parseArgv(argv: readonly string[]): Parsed {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = rest[index + 1];
      if (
        next !== undefined &&
        !next.startsWith("--") &&
        !BOOLEAN_FLAGS.has(name)
      ) {
        flags[name] = next;
        index += 1;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, flags };
}

function text(flags: Parsed["flags"], name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function sessionFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): SessionIdentity {
  return {
    session_id: env.EVIDENCE_SESSION_ID ?? `cli:${process.pid}`,
    provider: env.EVIDENCE_PROVIDER ?? "cli",
    model: env.EVIDENCE_MODEL ?? "none",
    thinking_level: null,
  };
}

// Every command returns an exit code; the CLI prints either human text or one
// JSON document, never both, so CI can parse it.
export async function runCli(
  argv: readonly string[],
  io: CliIo,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  const parsed = parseArgv(argv);
  const json = parsed.flags.json === true;
  const emit = (human: string, machine: unknown): void => {
    io.stdout(json ? `${JSON.stringify(machine, null, 2)}\n` : `${human}\n`);
  };
  const failWith = (message: string, code = 2): number => {
    if (json) io.stdout(`${JSON.stringify({ error: message }, null, 2)}\n`);
    else io.stderr(`evidence: ${message}\n`);
    return code;
  };
  if (parsed.command === "help" || parsed.flags.help === true) {
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  const root = await resolveRepoRoot(
    runProcess,
    text(parsed.flags, "cwd") ?? process.cwd(),
  );
  if (!root.ok) return failWith(root.error);
  const service = new EvidenceService({
    exec: runProcess,
    repoRoot: root.value,
    env,
  });
  const unwrap = <T>(result: Result<T>): T | null =>
    result.ok ? result.value : null;

  switch (parsed.command) {
    case "config": {
      const recipe = await service.describeRecipe();
      const pin = await service.pinStatus();
      if (!recipe.ok) return failWith(recipe.error);
      emit(`${recipe.value}\n${pin.ok ? pin.value.text : pin.error}`, {
        recipe: recipe.value,
        pin: pin.ok ? pin.value.state : null,
      });
      return 0;
    }
    case "status": {
      const status = await service.status();
      if (!status.ok) return failWith(status.error);
      emit(status.value, { status: status.value.split("\n") });
      return 0;
    }
    case "show": {
      const shown = await service.show(parsed.positional[0]);
      if (!shown.ok) return failWith(shown.error);
      const bundle = await service.load(parsed.positional[0]);
      emit(shown.value, unwrap(bundle));
      return 0;
    }
    case "accept": {
      const by = text(parsed.flags, "by");
      if (by === undefined) return failWith("accept needs --by NAME");
      const accepted = await service.acceptCurrentRecipe(by);
      if (!accepted.ok) return failWith(accepted.error);
      emit(accepted.value, { accepted: true, by });
      return 0;
    }
    case "init": {
      const result = await service.init(parsed.flags.force === true);
      if (!result.ok) return failWith(result.error);
      emit(result.value, { initialized: true });
      return 0;
    }
    case "run":
    case "gate":
    case "compare": {
      const by = text(parsed.flags, "by");
      const acceptRecipe =
        parsed.flags["accept-recipe"] === true ||
        (parsed.command === "gate" && by !== undefined)
          ? by === undefined
            ? undefined
            : { by }
          : undefined;
      if (
        parsed.flags["accept-recipe"] === true &&
        acceptRecipe === undefined
      ) {
        return failWith("--accept-recipe needs --by NAME");
      }
      const baseRef = text(parsed.flags, "base") ?? null;
      if (parsed.command === "compare" && baseRef === null)
        return failWith("compare needs --base REF");
      const only = (text(parsed.flags, "only") ?? "")
        .split(",")
        .filter((p) => p !== "");
      const outcome = await service.run({
        only,
        requirement: text(parsed.flags, "requirement") ?? null,
        baseRef,
        session: sessionFromEnv(env),
        acceptRecipe,
      });
      if (!outcome.ok) return failWith(outcome.error);
      const attestationLine =
        outcome.value.attestation === null
          ? `attestation : non écrite (${outcome.value.attestation_error ?? "?"})`
          : outcome.value.attestation.keyid === null
            ? "attestation : écrite, non signée (aucune clé de signature résolue)"
            : `attestation : signée ${outcome.value.attestation.keyid}`;
      emit(
        `${summarize(outcome.value.bundle)}\n${attestationLine}\ndossier : ${outcome.value.file}`,
        {
          bundle: outcome.value.bundle,
          file: outcome.value.file,
          attestation: outcome.value.attestation,
          attestation_error: outcome.value.attestation_error,
        },
      );
      if (parsed.command === "gate")
        return outcome.value.bundle.verdict === "conformant" ? 0 : 1;
      return 0;
    }
    case "verify": {
      if (parsed.flags.ci === true) {
        const result = await service.verifyForCi(sessionFromEnv(env));
        if (!result.ok) return failWith(result.error);
        if (result.value.kind === "no-reference") {
          emit(`aucune référence à rejouer : ${result.value.reason}`, {
            skipped: true,
            reason: result.value.reason,
          });
          return 0;
        }
        const c = result.value.comparison;
        emit(
          `${c.outcome.toUpperCase()} (${result.value.protocol}) — référence ${c.reference_id}, rejeu ${c.candidate_id}${c.differences.length === 0 ? "" : `\n- ${c.differences.join("\n- ")}`}`,
          {
            protocol: result.value.protocol,
            comparison: c,
            bundle: result.value.bundle,
          },
        );
        return c.outcome === "reproduced" ? 0 : 1;
      }
      const id = parsed.positional[0];
      if (parsed.flags["if-present"] === true) {
        const existing = await service.load(id);
        if (!existing.ok) {
          emit("aucun dossier à rejouer (--if-present)", {
            skipped: true,
            reason: existing.error,
          });
          return 0;
        }
      }
      const verified = await service.verify(id, sessionFromEnv(env));
      if (!verified.ok) return failWith(verified.error);
      const c = verified.value.comparison;
      emit(
        `${c.outcome.toUpperCase()} — référence ${c.reference_id}, rejeu ${c.candidate_id}${c.differences.length === 0 ? "" : `\n- ${c.differences.join("\n- ")}`}`,
        { comparison: c, bundle: verified.value.bundle },
      );
      if (parsed.flags["require-reproduced"] === true)
        return c.outcome === "reproduced" ? 0 : 1;
      return 0;
    }
    case "attach": {
      const kind = text(parsed.flags, "kind");
      const file = text(parsed.flags, "file");
      if (kind === undefined || file === undefined)
        return failWith("attach needs --kind and --file");
      const attached = await service.attach(parsed.positional[0], kind, file);
      if (!attached.ok) return failWith(attached.error);
      emit(
        `pièce jointe ${attached.value.kind} : ${attached.value.file} (${attached.value.report_verdict})`,
        attached.value,
      );
      return 0;
    }
    case "decide": {
      const by = text(parsed.flags, "by");
      const decision = text(parsed.flags, "decision");
      if (
        by === undefined ||
        (decision !== "accepted" && decision !== "rejected")
      ) {
        return failWith(
          "decide needs --by NAME and --decision accepted|rejected",
        );
      }
      const decided = await service.accept(
        parsed.positional[0],
        by,
        decision,
        text(parsed.flags, "note") ?? "",
      );
      if (!decided.ok) return failWith(decided.error);
      emit(
        summarizeAcceptance({
          schema_version: 1,
          bundle_id: "",
          attachments: [],
          decisions: [decided.value],
        }).join("\n"),
        decided.value,
      );
      return 0;
    }
    case "prune": {
      const keep = Number.parseInt(text(parsed.flags, "keep") ?? "", 10);
      if (Number.isNaN(keep)) return failWith("prune needs --keep N");
      const pruned = await service.prune(
        keep,
        parsed.flags["dry-run"] === true,
      );
      if (!pruned.ok) return failWith(pruned.error);
      emit(
        `retirés : ${pruned.value.removed.length}, conservés : ${pruned.value.kept.length}`,
        pruned.value,
      );
      return 0;
    }
    default:
      return failWith(`unknown command "${parsed.command}"\n${USAGE}`);
  }
}
