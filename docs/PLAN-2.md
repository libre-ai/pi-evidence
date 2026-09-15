# Plan 2 — prérequis de vente et complétude

Objectif : rendre le dossier de preuves opposable (signé, standard, rejoué
ailleurs), sûr (porte de confiance), différentiel (régression vs dette),
rattaché à l'exigence et à l'acceptation, et utilisable hors Pi (CLI, CI).
Invariants inchangés : cœur sans Pi, adaptation courte, zéro dépendance
d'exécution hors `typebox`, aucun marqueur privé. Format : `schema_version`
passe à 2 (champs ajoutés ; lecteur v1 accepté en lecture).

| Lot | Fichiers propriétaires | Contenu | Preuve |
| --- | --- | --- | --- |
| A Confiance | `src/trust.ts`, `extensions/evidence.ts`, `src/service.ts` | refus hors projet de confiance (Pi) ; épinglage `.evidence/recipe.lock` : recette inconnue ou changée → confirmation (TUI) ou refus (`--accept-recipe` en CLI) | tests : recette changée refusée puis acceptée ; recette réelle |
| B Attestation | `src/attestation.ts`, `src/signer.ts` | déclaration in-toto v1 (sujet = HEAD + empreintes d'arbre, prédicat = dossier), enveloppe DSSE ; signature SSH (`ssh-keygen -Y sign`) via la clé de signature git de l'auteur, vérification `-Y verify` avec `allowed_signers` ; non signé si aucune clé, dit explicitement | tests avec clé éphémère ; recette |
| C CLI | `bin/evidence.ts`, `src/cli.ts` | `run`, `status`, `show`, `verify`, `gate` (code de sortie), `init`, `compare`, `attach`, `accept`, `prune`, `--json` | tests d'intégration sur fixture ; recette |
| D CI | `.github/workflows/evidence-replay.yml` | rejeu de la recette sur la révision de la PR, comparaison au dossier commité de la même révision, échec si non `reproduced` ou non `conformant` | simulation locale des mêmes commandes (pas de remote) |
| E Différentiel | `src/differential.ts`, `src/environment.ts` | base dans un worktree détaché, classification regression / pre-existing / fixed / stable ; empreinte d'environnement (lockfiles, plateforme, outils) | tests fixture avec échec préexistant vs régression |
| F Exigence et acceptation | `src/acceptance.ts` | `requirement` (référence) sur le run ; `attach` d'un rapport externe (verdict `verify-runtime` extrait) ; `accept` humain signé | tests ; recette |
| G Journaux | `src/scrub.ts`, `src/prune.ts`, `src/discovery.ts` | caviardage des secrets avant écriture (empreinte sur le brut), `prune --keep`, découverte : `check` seul s'il existe | tests faux secrets ; recette |
| H Garde de tour | `extensions/evidence.ts` | `agent_end` : arbre modifié sans dossier correspondant → rappel (`remind`) ou message de suite (`require`) ; `policy` dans `.evidence.json` | tests faux `pi` ; recette |
| I Dogfooding | `docs/DOGFOODING.md` | runs réels sur trois dépôts, distribution des verdicts, temps, échecs réels | dossiers produits |

Hors périmètre (décision owner) : dépôt public de destination, publication des
preuves de la forge, Sigstore sans clé en CI (dépend d'un dépôt GitHub).
