# Recette observée — pi-evidence 0.1.0

Date : 2026-09-15. Pi Coding Agent 0.84.2 (`@earendil-works/pi-coding-agent`),
Bun 1.4.0, Node 26.8.2, cargo 1.97.0, macOS 15. Modèle utilisé pour les
sessions : `lmstudio` / `google/gemma-4-26b-a4b-qat` (local) ; le package ne
dépend d'aucun modèle particulier.

Profils Pi isolés (`PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`,
`--no-skills`, `PI_SKIP_VERSION_CHECK=1`) :

- `evidence-recette` : package installé par chemin **à côté de**
  `npm:@upstash/context7-pi@0.1.1` (package public représentatif) ;
- `evidence-archive` : package installé depuis l'archive extraite, puis retiré.

## 1. Installation, découverte, coexistence

| Contrôle | Observé |
| --- | --- |
| `pi install <chemin>` puis `pi list` | package listé ; à côté, `npm:@upstash/context7-pi@0.1.1` installé et listé |
| Écran de démarrage TUI | `[Extensions] @upstash/context7-pi@0.1.1:context7.ts, evidence.ts` |
| `pi install ./dist/libre-ai-pi-evidence-0.1.0.tgz` | accepté par Pi mais **l'extension ne se charge pas** (un chemin local vers une archive n'est pas extrait) ; `pi remove` doit recevoir la même forme relative que l'install |
| Archive extraite (`tar -xzf`) puis `pi install <dossier>/package` | extension chargée ; en session headless le modèle appelle `evidence_status` (6 appels observés) ; `pi remove <dossier>` → « No packages installed » |
| `/evidence help`, `/evidence config` | aide et recette déclarée affichées comme messages `[evidence-report]` |

## 2. Parcours réel (fixture git avec recette déclarée)

| Étape | Observé |
| --- | --- |
| `/evidence run` (arbre propre) | `CONFORMANT` ; 3 contrôles `passed` ; révision, modèle, session et dossier `.evidence/<id>.json` affichés |
| défaut volontaire (`defect.flag`) puis `/evidence run` | `FAILED` ; `test (requis) : failed exit 1` ; raison `test: failed (exit 1)` ; arbre marqué modifié (1 fichier) |
| `/evidence status` | deux dossiers, verdicts et révision (`*` si arbre modifié) |
| `/evidence verify` | `REPRODUCED` (l'échec est rejoué à l'identique) |
| défaut retiré puis `/evidence verify` | `STALE — working tree status differs` (résultats non comparables, nouveau dossier écrit) |
| `/reload` puis `/evidence status` | un seul rapport ajouté (9 entrées `evidence-report` en fin de session pour 9 commandes) : pas de duplication |
| Échap pendant `/evidence run` (contrôle de 30 s) | **non annulé** : le contrôle va au bout (`slow passed 30008 ms`). Un handler de commande ne reçoit pas de signal d'annulation dans Pi 0.84.2 |
| Échap pendant `evidence_run` appelé par le modèle | annulé : `slow : aborted, 0 ms`, dossier partiel écrit. Ce cas a révélé un verdict `conformant` erroné (contrôle annulé non requis) : corrigé, une interruption donne `incomplete` |
| Session headless `-p --mode json` alimentée seulement avec le package | le modèle appelle `evidence_run`, résultat `conformant`, identifiant et fichier retournés dans `details` |

## 3. Dépôt réel et découverte

| Cas | Observé |
| --- | --- |
| `/evidence run` sur ce dépôt (recette déclarée : `bun run lint`, `bun run typecheck`, `bun test`, `reuse lint`) | `CONFORMANT` ; durées 104 / 414 / 3 177 / 621 ms ; versions `bun 1.4.0`, `node v26.8.2`, `cargo 1.97.0` enregistrées |
| Fixture sans `.evidence.json` (scripts `lint`, `test`, `bun.lock`) | recette `discovered`, `bun run lint` / `bun run test` `passed`, verdict `unverified`, raisons « no declared criteria » et « not a conformance » |
| Répertoire hors git | « not a git repository: evidence needs a revision to bind to » |
| Contrôle inconnu (`/evidence run t,zzz`) | « unknown check id(s): zzz » |

## 4. Gate du package

`bun run check` : biome, tsc, 31 tests (couverture 99,6 % lignes), `reuse lint`
conforme, `scripts/check-markers.ts` sans marqueur privé. Archive
`dist/libre-ai-pi-evidence-0.1.0.tgz` (20 kB) : `package.json`, `README.md`,
`REUSE.toml`, `LICENSES/`, `docs/evidence.schema.json`, `extensions/`, `src/` ;
aucun test, aucun fichier local.

## 5. Non vérifié

- Mode RPC (le déploiement Pi de cette machine réserve `--mode rpc` à son
  lanceur d'intégrité).
- Annulation du chemin commande (voir §2) : seule l'annulation du chemin outil
  est effective.
- Autres versions de Pi, Linux, Windows.
