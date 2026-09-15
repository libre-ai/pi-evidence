// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import { bindRevision, collectToolVersions } from "./binding.ts";
import {
  bundleFile,
  bundleId,
  type EvidenceBundle,
  listBundleIds,
  loadBundle,
  type SessionIdentity,
  writeBundle,
} from "./bundle.ts";
import { type Comparison, compareBundles } from "./compare.ts";
import type { ExecFn } from "./exec.ts";
import { resolveRecipe, selectChecks } from "./recipe.ts";
import { fail, ok, type Result } from "./result.ts";
import { type CheckResult, runChecks } from "./runner.ts";
import { computeVerdict } from "./verdict.ts";

export interface ServiceDeps {
  readonly exec: ExecFn;
  readonly repoRoot: string;
  readonly now?: (() => Date) | undefined;
}

export interface RunRequest {
  readonly only: readonly string[];
  readonly session: SessionIdentity;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((result: CheckResult) => void) | undefined;
}

export interface RunOutcome {
  readonly bundle: EvidenceBundle;
  readonly file: string;
}

export async function resolveRepoRoot(
  exec: ExecFn,
  cwd: string,
): Promise<Result<string>> {
  const run = await exec("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    timeoutMs: 30_000,
  });
  if (!run.ok)
    return fail(
      run.error === "spawn-failed"
        ? "git is not installed"
        : `git ${run.error}`,
    );
  if (run.value.code !== 0)
    return fail("not a git repository: evidence needs a revision to bind to");
  return ok(run.value.stdout.trim());
}

export function summarize(bundle: EvidenceBundle): string {
  const lines = [
    `${bundle.id} — verdict ${bundle.verdict.toUpperCase()} (${bundle.recipe.origin} recipe, criteria ${bundle.criteria_declared ? "declared" : "none"})`,
    `révision ${bundle.revision.head.slice(0, 12)}${bundle.revision.branch === null ? "" : ` (${bundle.revision.branch})`}${bundle.revision.dirty ? `, arbre modifié : ${bundle.revision.changed_files.length} fichier(s)` : ", arbre propre"}`,
    `modèle ${bundle.session.provider}/${bundle.session.model}, session ${bundle.session.session_id}`,
  ];
  for (const result of bundle.results) {
    lines.push(
      `- ${result.id}${result.required ? " (requis)" : ""} : ${result.status}${result.exit_code === null ? "" : ` exit ${result.exit_code}`}, ${result.duration_ms} ms — ${result.command} ${result.args.join(" ")}`,
    );
  }
  for (const reason of bundle.reasons) lines.push(`  ${reason}`);
  return lines.join("\n");
}

export class EvidenceService {
  constructor(private readonly deps: ServiceDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  async describeRecipe(): Promise<Result<string>> {
    const recipe = await resolveRecipe(this.deps.repoRoot);
    if (!recipe.ok) return recipe;
    const lines = [
      `recette ${recipe.value.origin} (${recipe.value.hash.slice(0, 12)}), sortie ${recipe.value.output_dir}/`,
    ];
    for (const check of recipe.value.checks) {
      lines.push(
        `- ${check.id}${check.required ? " (requis)" : ""} : ${check.command} ${check.args.join(" ")} [${check.timeout_seconds} s]`,
      );
    }
    lines.push(
      recipe.value.checks.some((c) => c.required)
        ? "critères déclarés : oui"
        : "critères déclarés : non (meilleur verdict possible : unverified)",
    );
    return ok(lines.join("\n"));
  }

  async run(request: RunRequest): Promise<Result<RunOutcome>> {
    const recipe = await resolveRecipe(this.deps.repoRoot);
    if (!recipe.ok) return recipe;
    const selected = selectChecks(recipe.value, request.only);
    if (!selected.ok) return selected;
    const revision = await bindRevision(this.deps.exec, this.deps.repoRoot, [
      recipe.value.output_dir,
    ]);
    if (!revision.ok) return revision;
    const createdAt = this.now();
    const outputDir = join(this.deps.repoRoot, recipe.value.output_dir);
    // Two runs within the same second on the same head must not overwrite
    // each other: a later bundle gets a numeric suffix.
    const base = bundleId(createdAt, revision.value.head);
    const existing = await listBundleIds(outputDir);
    let id = base;
    for (let suffix = 2; existing.includes(id); suffix += 1)
      id = `${base}-${suffix}`;
    const results = await runChecks(selected.value, {
      exec: this.deps.exec,
      repoRoot: this.deps.repoRoot,
      logDir: join(outputDir, id),
      signal: request.signal,
      now: () => this.now(),
      onProgress: request.onProgress,
    });
    // The tree is bound again after the run: a check that mutates the
    // working tree (formatter, generated file) invalidates the evidence.
    const after = await bindRevision(this.deps.exec, this.deps.repoRoot, [
      recipe.value.output_dir,
    ]);
    const explanation = computeVerdict(
      results,
      recipe.value.origin,
      request.only.length === 0,
    );
    const reasons = [...explanation.reasons];
    let verdict = explanation.verdict;
    if (
      after.ok &&
      (after.value.diff_sha256 !== revision.value.diff_sha256 ||
        after.value.status_sha256 !== revision.value.status_sha256)
    ) {
      reasons.push(
        "working tree changed during the run: evidence bound to the pre-run tree is not conformant",
      );
      if (verdict === "conformant") verdict = "incomplete";
    }
    const bundle: EvidenceBundle = {
      schema_version: 1,
      id,
      created_at: createdAt.toISOString(),
      repository_root: this.deps.repoRoot,
      revision: revision.value,
      recipe: {
        origin: recipe.value.origin,
        hash: recipe.value.hash,
        checks: recipe.value.checks,
        selected: selected.value.map((c) => c.id),
      },
      results,
      verdict,
      reasons,
      criteria_declared: explanation.criteria_declared,
      session: request.session,
      tools: await collectToolVersions(this.deps.exec, this.deps.repoRoot),
    };
    const file = await writeBundle(outputDir, bundle);
    return ok({ bundle, file });
  }

  private async outputDir(): Promise<Result<string>> {
    const recipe = await resolveRecipe(this.deps.repoRoot);
    if (!recipe.ok) return recipe;
    return ok(join(this.deps.repoRoot, recipe.value.output_dir));
  }

  async status(): Promise<Result<string>> {
    const dir = await this.outputDir();
    if (!dir.ok) return dir;
    const ids = await listBundleIds(dir.value);
    if (ids.length === 0)
      return ok(`aucun dossier de preuves dans ${dir.value}`);
    const lines: string[] = [];
    for (const id of ids) {
      const bundle = await loadBundle(bundleFile(dir.value, id));
      lines.push(
        bundle.ok
          ? `${id}  ${bundle.value.verdict}  ${bundle.value.revision.head.slice(0, 7)}${bundle.value.revision.dirty ? "*" : ""}  ${bundle.value.results.length} contrôle(s)`
          : `${id}  (illisible : ${bundle.error})`,
      );
    }
    return ok(lines.join("\n"));
  }

  async load(id?: string): Promise<Result<EvidenceBundle>> {
    const dir = await this.outputDir();
    if (!dir.ok) return dir;
    const target = id ?? (await listBundleIds(dir.value)).at(-1);
    if (target === undefined) return fail("aucun dossier de preuves");
    if (!/^[A-Za-z0-9-]+$/.test(target)) return fail("invalid bundle id");
    return loadBundle(bundleFile(dir.value, target));
  }

  async show(id?: string): Promise<Result<string>> {
    const bundle = await this.load(id);
    if (!bundle.ok) return bundle;
    return ok(summarize(bundle.value));
  }

  async verify(
    id: string | undefined,
    session: SessionIdentity,
    signal?: AbortSignal,
  ): Promise<Result<{ comparison: Comparison; bundle: EvidenceBundle }>> {
    const reference = await this.load(id);
    if (!reference.ok) return reference;
    const rerun = await this.run({
      only:
        reference.value.recipe.selected.length ===
        reference.value.recipe.checks.length
          ? []
          : reference.value.recipe.selected,
      session,
      signal,
    });
    if (!rerun.ok) return rerun;
    return ok({
      comparison: compareBundles(reference.value, rerun.value.bundle),
      bundle: rerun.value.bundle,
    });
  }
}
