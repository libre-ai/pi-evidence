# pi-evidence Canonical Agent Rules

## Authority

Evidence brick of the Libre AI constellation, couche 2 (agent tooling):
a Pi Coding Agent package, CLI and CI replay that run a repository's declared
checks and record signed, revision-bound evidence with an honest verdict
(conformant, failed, incomplete, unverified).
Doctrine lives upstream: https://raw.githubusercontent.com/libre-ai/governance/main/docs/README.md
The recipe this repository declares is the governed `bun` variant of
`distribution/templates/evidence/` in `libre-ai/governance`.

## Boundaries

- The recipe runner, verdict rules, attestation format and CLI are owned
  here; the fleet recipe variants and the conformance gate are owned by
  `libre-ai/governance`.
- Runtime verification at the exposed surface is the `verify-runtime`
  governed skill; its report attaches to a bundle, it is not re-implemented.
- No model, provider or hosting choice lives here: the package binds the
  identity a session reports, it never selects one.

## Quality gates

Run `bun run check` before pushing (biome, tsc, tests with the per-file
coverage threshold, REUSE, private-marker scan); never hide a red test.
Every pull request carries its own evidence: a code commit, then an
evidence-only commit with `.evidence/*.json` produced by `evidence run`
(replayed by the `evidence-replay` workflow).

## Agents

- Read actual state before editing; a bundle attests a tree, not a claim.
- Commands and arguments stay arrays; no shell string is ever built from
  recipe fields.
- Security > quality > performance > completeness.
