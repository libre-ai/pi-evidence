// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: Apache-2.0

import { basename, join } from "node:path";
import {
  type AcceptanceDecision,
  type Attachment,
  attachReport,
  readAcceptance,
  recordDecision,
  summarizeAcceptance,
} from "./acceptance.ts";
import { verifyAttestation, writeAttestation } from "./attestation.ts";
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
import { runDifferential, summarizeDifferential } from "./differential.ts";
import { fingerprintEnvironment } from "./environment.ts";
import type { ExecFn } from "./exec.ts";
import { initRecipe } from "./init.ts";
import { type PruneReport, pruneBundles } from "./prune.ts";
import { resolveRecipe, selectChecks } from "./recipe.ts";
import { fail, ok, type Result } from "./result.ts";
import { type CheckResult, runChecks } from "./runner.ts";
import {
  createSshSigner,
  createSshVerifier,
  gitConfigReader,
  resolveSigningKey,
  type Signer,
  type Verifier,
} from "./signer.ts";
import {
  acceptRecipe,
  checkRecipePin,
  describePin,
  type PinState,
} from "./trust.ts";
import { computeVerdict } from "./verdict.ts";

export interface ServiceDeps {
  readonly exec: ExecFn;
  readonly repoRoot: string;
  readonly now?: (() => Date) | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  // Test seam: replaces signing-key resolution (SSH key from env/git config).
  readonly signerFactory?: (() => Promise<Signer | null>) | undefined;
}

export interface RunRequest {
  readonly only: readonly string[];
  readonly session: SessionIdentity;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((result: CheckResult) => void) | undefined;
  // A reference to what the change was asked to do (ticket, criterion).
  readonly requirement?: string | null | undefined;
  // Explicit acceptance of a recipe that is not pinned yet or has changed.
  readonly acceptRecipe?: { readonly by: string } | undefined;
  // When set, the same checks also run on this base revision (differential).
  readonly baseRef?: string | null | undefined;
}

export interface AttestationInfo {
  readonly statement: string;
  readonly envelope: string | null;
  readonly keyid: string | null;
}

export interface RunOutcome {
  readonly bundle: EvidenceBundle;
  readonly file: string;
  readonly attestation: AttestationInfo | null;
  readonly attestation_error: string | null;
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
  if (bundle.requirement !== null)
    lines.push(`exigence : ${bundle.requirement}`);
  for (const result of bundle.results) {
    const redacted =
      result.redactions.length === 0
        ? ""
        : ` [${result.redactions.reduce((n, r) => n + r.count, 0)} caviardage(s)]`;
    lines.push(
      `- ${result.id}${result.required ? " (requis)" : ""} : ${result.status}${result.exit_code === null ? "" : ` exit ${result.exit_code}`}, ${result.duration_ms} ms — ${result.command} ${result.args.join(" ")}${redacted}`,
    );
  }
  for (const reason of bundle.reasons) lines.push(`  ${reason}`);
  if (bundle.differential !== null) {
    lines.push(
      `différentiel vs ${bundle.differential.base_ref} (${bundle.differential.base_head.slice(0, 7)}) :`,
    );
    const details = summarizeDifferential(bundle.differential);
    if (details.length === 0)
      lines.push("  aucun changement d'état de contrôle");
    for (const line of details) lines.push(`  ${line}`);
  }
  return lines.join("\n");
}

export class EvidenceService {
  constructor(private readonly deps: ServiceDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private async signer(): Promise<Signer | null> {
    if (this.deps.signerFactory !== undefined) return this.deps.signerFactory();
    const keyPath = await resolveSigningKey(
      this.deps.env ?? process.env,
      gitConfigReader(this.deps.exec, this.deps.repoRoot),
    );
    if (keyPath === null) return null;
    const signer = await createSshSigner(this.deps.exec, { keyPath });
    return signer.ok ? signer.value : null;
  }

  // Identity, never a path: the origin URL with any embedded credentials
  // stripped, or null when the repository has no origin remote.
  private async repositoryIdentity(): Promise<{
    name: string;
    origin: string | null;
  }> {
    const remote = await this.deps.exec(
      "git",
      ["remote", "get-url", "origin"],
      {
        cwd: this.deps.repoRoot,
        timeoutMs: 30_000,
      },
    );
    let origin: string | null = null;
    if (remote.ok && remote.value.code === 0) {
      origin = remote.value.stdout.trim().replace(/\/\/[^@/]+@/, "//");
      if (origin === "") origin = null;
    }
    return { name: basename(this.deps.repoRoot), origin };
  }

  private verifier(): Verifier | null {
    const allowed = (this.deps.env ?? process.env).EVIDENCE_ALLOWED_SIGNERS;
    if (allowed === undefined || allowed === "") return null;
    return createSshVerifier(this.deps.exec, { allowedSignersFile: allowed });
  }

  async describeRecipe(): Promise<Result<string>> {
    const recipe = await resolveRecipe(this.deps.repoRoot);
    if (!recipe.ok) return recipe;
    const lines = [
      `recette ${recipe.value.origin} (${recipe.value.hash.slice(0, 12)}), sortie ${recipe.value.output_dir}/, politique de garde ${recipe.value.policy}`,
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

  async pinStatus(): Promise<
    Result<{ state: PinState; hash: string; text: string }>
  > {
    const recipe = await resolveRecipe(this.deps.repoRoot);
    if (!recipe.ok) return recipe;
    const pin = await checkRecipePin(
      join(this.deps.repoRoot, recipe.value.output_dir),
      recipe.value.hash,
    );
    if (!pin.ok) return pin;
    return ok({
      state: pin.value,
      hash: recipe.value.hash,
      text: describePin(pin.value, recipe.value.hash),
    });
  }

  async acceptCurrentRecipe(by: string): Promise<Result<string>> {
    const recipe = await resolveRecipe(this.deps.repoRoot);
    if (!recipe.ok) return recipe;
    const lock = await acceptRecipe(
      join(this.deps.repoRoot, recipe.value.output_dir),
      recipe.value.hash,
      by,
      this.now(),
    );
    return ok(`recette ${lock.recipe_sha256.slice(0, 12)} acceptée par ${by}`);
  }

  async run(request: RunRequest): Promise<Result<RunOutcome>> {
    const recipe = await resolveRecipe(this.deps.repoRoot);
    if (!recipe.ok) return recipe;
    const selected = selectChecks(recipe.value, request.only);
    if (!selected.ok) return selected;
    const outputDir = join(this.deps.repoRoot, recipe.value.output_dir);
    const pin = await checkRecipePin(outputDir, recipe.value.hash);
    if (!pin.ok) return pin;
    if (pin.value.state !== "pinned") {
      if (request.acceptRecipe === undefined) {
        return fail(
          `${describePin(pin.value, recipe.value.hash)} ; acceptation explicite requise avant exécution`,
        );
      }
      await acceptRecipe(
        outputDir,
        recipe.value.hash,
        request.acceptRecipe.by,
        this.now(),
      );
    }
    const revision = await bindRevision(this.deps.exec, this.deps.repoRoot, [
      recipe.value.output_dir,
    ]);
    if (!revision.ok) return revision;
    const createdAt = this.now();
    // Two runs within the same second on the same head must not overwrite
    // each other: a later bundle gets a numeric suffix.
    const base = bundleId(createdAt, revision.value.head);
    const existing = await listBundleIds(outputDir);
    let id = base;
    for (let suffix = 2; existing.includes(id); suffix += 1)
      id = `${base}-${suffix}`;
    const environment = await fingerprintEnvironment(this.deps.repoRoot);
    const results = await runChecks(selected.value, {
      exec: this.deps.exec,
      repoRoot: this.deps.repoRoot,
      logDir: join(outputDir, id),
      logRoot: outputDir,
      signal: request.signal,
      now: () => this.now(),
      onProgress: request.onProgress,
    });
    let differential: EvidenceBundle["differential"] = null;
    const reasons: string[] = [];
    if (request.baseRef !== undefined && request.baseRef !== null) {
      const diff = await runDifferential({
        exec: this.deps.exec,
        repoRoot: this.deps.repoRoot,
        baseRef: request.baseRef,
        checks: selected.value,
        candidateResults: results,
        candidateEnvironment: environment,
        logDir: join(outputDir, id),
        logRoot: outputDir,
        signal: request.signal,
        now: () => this.now(),
      });
      if (!diff.ok) return fail(`differential: ${diff.error}`);
      differential = diff.value;
    }
    // Dogfooding finding: an output directory that git does not ignore is
    // seen by checks that scan untracked files (REUSE, secret scanners) and
    // makes the repository fail its own gate. Said, not hidden.
    const ignored = await this.deps.exec(
      "git",
      ["check-ignore", "-q", recipe.value.output_dir],
      { cwd: this.deps.repoRoot, timeoutMs: 30_000 },
    );
    const ignoreWarning =
      ignored.ok && ignored.value.code !== 0
        ? `${recipe.value.output_dir}/ is not ignored by git: checks that scan untracked files may fail because of the evidence itself (add it to .gitignore)`
        : null;
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
    // Verdict reasons first: they are what a reader acts on; the hygiene
    // warning comes last.
    reasons.push(...explanation.reasons);
    if (ignoreWarning !== null) reasons.push(ignoreWarning);
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
      schema_version: 2,
      id,
      created_at: createdAt.toISOString(),
      repository: await this.repositoryIdentity(),
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
      requirement: request.requirement ?? null,
      environment,
      differential,
      session: request.session,
      tools: await collectToolVersions(this.deps.exec, this.deps.repoRoot),
    };
    const file = await writeBundle(outputDir, bundle);
    // The attestation is best effort at this layer: the bundle is written
    // first, and a signing problem is reported, never hidden, never fatal.
    const attested = await writeAttestation(
      outputDir,
      bundle,
      await this.signer(),
    );
    return ok({
      bundle,
      file,
      attestation: attested.ok ? attested.value : null,
      attestation_error: attested.ok ? null : attested.error,
    });
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
      if (!bundle.ok) {
        lines.push(`${id}  (illisible : ${bundle.error})`);
        continue;
      }
      const attestation = await verifyAttestation(
        dir.value,
        id,
        this.verifier(),
      );
      const signed = attestation.ok
        ? attestation.value.signed
          ? attestation.value.valid === null
            ? "signé"
            : attestation.value.valid
              ? "signé, vérifié"
              : "signé, INVALIDE"
          : "non signé"
        : "sans attestation";
      lines.push(
        `${id}  ${bundle.value.verdict}  ${bundle.value.revision.head.slice(0, 7)}${bundle.value.revision.dirty ? "*" : ""}  ${bundle.value.results.length} contrôle(s)  ${signed}`,
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
    const dir = await this.outputDir();
    if (!dir.ok) return dir;
    const lines = [summarize(bundle.value)];
    const attestation = await verifyAttestation(
      dir.value,
      bundle.value.id,
      this.verifier(),
    );
    if (!attestation.ok) lines.push("attestation : absente");
    else if (!attestation.value.signed)
      lines.push("attestation : présente, non signée");
    else
      lines.push(
        `attestation : signée ${attestation.value.keyid ?? "?"}${attestation.value.valid === null ? " (non vérifiée : EVIDENCE_ALLOWED_SIGNERS absent)" : attestation.value.valid ? ", vérifiée" : ", INVALIDE"}`,
      );
    const acceptance = await readAcceptance(dir.value, bundle.value.id);
    if (acceptance.ok) lines.push(...summarizeAcceptance(acceptance.value));
    return ok(lines.join("\n"));
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

  // CI protocol. A bundle cannot be committed inside the revision it attests,
  // so evidence arrives in a follow-up commit that touches only the output
  // directory. When HEAD is such a commit, its parent's bundles are the
  // reference and the trees under test are identical by construction.
  async verifyForCi(
    session: SessionIdentity,
    signal?: AbortSignal,
  ): Promise<
    Result<
      | { kind: "no-reference"; reason: string }
      | {
          kind: "compared";
          protocol: "same-head" | "evidence-only-commit";
          comparison: Comparison;
          bundle: EvidenceBundle;
        }
    >
  > {
    const recipe = await resolveRecipe(this.deps.repoRoot);
    if (!recipe.ok) return recipe;
    const dir = join(this.deps.repoRoot, recipe.value.output_dir);
    const head = await this.deps.exec("git", ["rev-parse", "HEAD"], {
      cwd: this.deps.repoRoot,
      timeoutMs: 30_000,
    });
    if (!head.ok || head.value.code !== 0) return fail("cannot resolve HEAD");
    const headSha = head.value.stdout.trim();
    // Only bundles tracked by git can be a reference: a bundle written by
    // this very job (the gate step) must never be compared with itself.
    const tracked = await this.deps.exec(
      "git",
      ["ls-files", "-z", "--", recipe.value.output_dir],
      { cwd: this.deps.repoRoot, timeoutMs: 30_000 },
    );
    const trackedFiles = new Set(
      tracked.ok && tracked.value.code === 0
        ? tracked.value.stdout.split("\0").filter((f) => f !== "")
        : [],
    );
    const bundles: EvidenceBundle[] = [];
    for (const id of await listBundleIds(dir)) {
      if (!trackedFiles.has(`${recipe.value.output_dir}/${id}.json`)) continue;
      const loaded = await loadBundle(bundleFile(dir, id));
      if (loaded.ok) bundles.push(loaded.value);
    }
    let protocol: "same-head" | "evidence-only-commit" = "same-head";
    let reference = bundles.filter((b) => b.revision.head === headSha).at(-1);
    if (reference === undefined) {
      const changed = await this.deps.exec(
        "git",
        ["diff", "--name-only", "HEAD~1", "HEAD"],
        { cwd: this.deps.repoRoot, timeoutMs: 30_000 },
      );
      const parent = await this.deps.exec("git", ["rev-parse", "HEAD~1"], {
        cwd: this.deps.repoRoot,
        timeoutMs: 30_000,
      });
      const files =
        changed.ok && changed.value.code === 0
          ? changed.value.stdout.split("\n").filter((f) => f !== "")
          : [];
      const prefix = `${recipe.value.output_dir}/`;
      const evidenceOnly =
        files.length > 0 && files.every((f) => f.startsWith(prefix));
      if (evidenceOnly && parent.ok && parent.value.code === 0) {
        const parentSha = parent.value.stdout.trim();
        reference = bundles.filter((b) => b.revision.head === parentSha).at(-1);
        protocol = "evidence-only-commit";
      }
    }
    if (reference === undefined) {
      return ok({
        kind: "no-reference",
        reason: `no committed bundle for ${headSha.slice(0, 7)} (nor for its parent through an evidence-only commit)`,
      });
    }
    const rerun = await this.run({
      only:
        reference.recipe.selected.length === reference.recipe.checks.length
          ? []
          : reference.recipe.selected,
      session,
      signal,
    });
    if (!rerun.ok) return rerun;
    return ok({
      kind: "compared",
      protocol,
      comparison: compareBundles(reference, rerun.value.bundle, {
        headMayDiffer: protocol === "evidence-only-commit",
      }),
      bundle: rerun.value.bundle,
    });
  }

  async attach(
    id: string | undefined,
    kind: string,
    file: string,
  ): Promise<Result<Attachment>> {
    const bundle = await this.load(id);
    if (!bundle.ok) return bundle;
    const dir = await this.outputDir();
    if (!dir.ok) return dir;
    return attachReport({
      outputDir: dir.value,
      id: bundle.value.id,
      kind,
      file,
      now: this.now(),
    });
  }

  async accept(
    id: string | undefined,
    by: string,
    decision: "accepted" | "rejected",
    note: string,
  ): Promise<Result<AcceptanceDecision>> {
    const bundle = await this.load(id);
    if (!bundle.ok) return bundle;
    const dir = await this.outputDir();
    if (!dir.ok) return dir;
    return recordDecision({
      outputDir: dir.value,
      id: bundle.value.id,
      by,
      decision,
      note,
      now: this.now(),
      signer: await this.signer(),
    });
  }

  async prune(keep: number, dryRun: boolean): Promise<Result<PruneReport>> {
    const dir = await this.outputDir();
    if (!dir.ok) return dir;
    return pruneBundles(dir.value, { keep, dryRun });
  }

  async init(force: boolean): Promise<Result<string>> {
    const result = await initRecipe(this.deps.repoRoot, { force });
    if (!result.ok) return result;
    return ok(
      `recette écrite : ${result.value.file} (${result.value.checks.join(", ")}) ; marquer required: true sur les critères, puis accept`,
    );
  }
}
