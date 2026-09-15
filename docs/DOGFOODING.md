# Dogfooding — trois dépôts réels

Date : 2026-09-15, CLI `bun bin/evidence.ts gate --json`, identité de session
`dogfood`/`cli`/`none`. Les dossiers écrits dans les dépôts tiers ont été
retirés après lecture ; seuls les résultats sont conservés ici.

| Dépôt | Recette | Verdict | Contrôles | Observation |
| --- | --- | --- | --- | --- |
| `pi-evidence` (ce dépôt) | déclarée, 3 requis + `reuse lint` | `conformant` | lint 145 ms, typecheck 430 ms, test 7 579 ms, licenses 559 ms | attestation écrite ; lockfile `bun.lock` empreinté |
| dépôt privé de recherche (nom retiré du package, arbre avec WIP) | découverte : `bun run check` | `failed` puis `unverified` | `check` 1 687 ms (échec) puis 3 451 ms (succès) | **défaut trouvé** : le premier run a échoué sur `check:licenses` parce que `.evidence/` (non ignoré par git) est vu par `reuse lint` ; avec `.evidence/` ignoré, le gate passe. Verdict `unverified` : aucun critère déclaré |
| `knowledge` (flotte) | découverte : `bun run check` | `unverified` | `check` 939 ms | `node_modules` présent ; le contrôle composite passe ; aucun critère déclaré |

## Enseignements

1. **La preuve pollue l'arbre qu'elle mesure** si son répertoire n'est pas
   ignoré : un gate qui scanne les fichiers non suivis (REUSE, scan de
   secrets) échoue à cause du dossier de preuves lui-même. Correction livrée :
   le run ajoute une raison explicite quand `.evidence/` n'est pas ignoré par
   git ; la recommandation `.gitignore` figure dans le README. Décision non
   prise à la place du dépôt : ignorer ou commiter les dossiers reste un choix
   du propriétaire.
2. **Sans recette déclarée, la flotte ne dépasse pas `unverified`.** Deux
   dépôts sur trois n'ont aucun critère : le gabarit gouverné et `evidence
   init` sont le prérequis pour parler de conformité.
3. **Mesure de substitution : aucune donnée.** Un cycle d'usage réel sur des
   changements successifs est nécessaire avant tout chiffre d'offre ; ce
   dogfooding ne mesure que la distribution des verdicts sur un instant.
