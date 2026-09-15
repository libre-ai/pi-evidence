# Plan de réalisation

Objectif : `/evidence run` utilisable dans une session Pi réelle sur un dépôt
de la flotte, avec dossier de preuves lié et verdict honnête.
Invariants : logique testable sans Pi (`src/`), adaptation Pi courte
(`extensions/evidence.ts`), aucune dépendance d'exécution hors `typebox`
(fourni par Pi), aucune référence à un dispositif privé.
Critère de fin : critères de clôture ci-dessous prouvés dans `docs/RECETTE.md`.

| Module | Rôle | Tests clés |
| --- | --- | --- |
| `src/result.ts` | valeurs succès/échec explicites | — |
| `src/exec.ts` | sous-processus par tableau d'arguments, délai, annulation, capture | code, timeout, abort, spawn absent |
| `src/config.ts` | lecture et validation de `.evidence.json` | champs manquants, commande avec espace refusée |
| `src/discovery.ts` | recette découverte depuis `package.json` / `Cargo.toml` | bun.lock vs npm, absence de scripts |
| `src/recipe.ts` | recette effective, empreinte canonique | même recette = même empreinte |
| `src/binding.ts` | liaison révision (git) et versions d'outils | dépôt propre / sale, hors git refusé |
| `src/runner.ts` | exécution séquentielle, journaux, statuts | passed/failed/timeout/aborted/unavailable/skipped |
| `src/verdict.ts` | règles de verdict | précédence, `conformant` impossible sans critère |
| `src/bundle.ts` | dossier JSON, écriture atomique, listing, schéma | round-trip, tri, schéma ajv |
| `src/compare.ts` | rejouer et comparer | reproduced/diverged/stale |
| `src/service.ts` | orchestration des actions | parcours nominal et erreurs |
| `extensions/evidence.ts` | commande, outils, cycle de session | fausse API Pi |

Critères de clôture :

1. Installable par chemin et par archive `bun run pack` dans un profil Pi
   isolé, à côté d'un package public représentatif ; commande et outils
   découverts.
2. Parcours réel : `run` sur un dépôt de la flotte et sur une fixture ;
   défaut volontaire → `failed` avec le contrôle nommé ; contrôle requis
   absent → `incomplete` ; sans critères → `unverified` ; `verify` → `reproduced`.
3. Tests déterministes verts, couverture ≥ 90 %, biome, tsc, reuse.
4. Entrées invalides et dépendances manquantes sans faux succès.
5. Annulation observée ; rechargement sans duplication.
6. Aucun marqueur privé dans le package (`scripts/check-markers.ts`).
7. Retrait par `pi remove`, données conservées.
