# Recette observée — plan 2 (v0.1.0, format de dossier v2)

Date : 2026-09-15. Pi 0.84.2, Bun 1.4.0, Node 26.8.2, OpenSSH 10.3, git
2.55, macOS 15. Modèle des sessions : `lmstudio` / `google/gemma-4-26b-a4b-qat`.
Profil `~/.pi/profiles/evidence-recette` (package par chemin, `--no-skills`,
`-a` pour approuver le projet de la fixture, clé SSH **éphémère** générée dans
le profil pour la signature : `EVIDENCE_SSH_KEY`, `EVIDENCE_ALLOWED_SIGNERS`).

## 1. Session TUI réelle (fixture git, recette déclarée)

| Étape | Observé |
| --- | --- |
| `/evidence config` | recette, critères, politique `remind`, et « recette jamais acceptée (db35d24ad440) » |
| `/evidence run --requirement REQ-42` | boîte de confirmation « Recette de preuves … Exécuter cette recette ? Chaque commande tourne avec vos droits. » Yes/No |
| Yes | `CONFORMANT`, `exigence : REQ-42`, dossier écrit |
| `/evidence show` | `attestation : signée SHA256:WTWEZ…, vérifiée` |
| `/evidence run` (seconde fois) | aucune boîte de confirmation (recette épinglée), nouveau dossier signé |
| `/evidence status` | dossiers v1 antérieurs listés `sans attestation`, les deux nouveaux `signé, vérifié` (lecture des dossiers v1 conservée) |
| Édition de `README.md` par le modèle (outil `edit`), fin de tour | message `[evidence-reminder]` : « l'arbre a changé pendant ce tour et aucun dossier de preuves ne correspond à cet état » ; une seule alerte |
| `/evidence run --base HEAD` | bloc « différentiel vs HEAD (b4fa9aa) », note « dependencies not reused (no node_modules …) », contrôles stables ; `git worktree list` ne montre que l'arbre principal après coup |

## 2. CLI et simulation du job CI (mêmes commandes que le workflow)

| Commande | Observé |
| --- | --- |
| `evidence accept --by ci:sim` | recette épinglée |
| `evidence gate --json` | exit 0, `conformant`, attestation écrite non signée (pas de clé dans cet environnement) |
| `evidence verify --json --require-reproduced --if-present` | exit 0, `reproduced`, aucune différence |
| défaut volontaire puis `evidence gate` | exit 1, `FAILED`, `test (requis) : failed exit 1` ; identifiant suffixé `-2` (même seconde) |
| `evidence attach --kind verify-runtime --file …` | pièce jointe enregistrée, verdict `PASS` extrait |
| `evidence decide --by recette --decision accepted --note …` | décision enregistrée (non signée dans cet environnement) |
| `evidence prune --keep 3` | 10 dossiers retirés, 3 conservés ; `recipe.lock.json` intact |
| archive `bun run pack` | 43 Ko : `bin/`, `src/`, `extensions/`, `docs/evidence.schema.json`, `README.md`, `LICENSES/`, `REUSE.toml` |

## 3. Gate du package

`bun run check` : biome, tsc, 100 tests (couverture ≥ 98,8 % lignes, 100 %
fonctions ; seuil Bun appliqué par fichier), `reuse lint`, scan de marqueurs
privés. Lots livrés par agents parallèles avec rapports vérifiés par
exécution des suites : attestation/signature (19 tests, clés éphémères),
différentiel/environnement (12), caviardage/rétention/découverte (28).

## 4. Écarts trouvés pendant la recette et corrigés

- `ssh-keygen -Y verify` ne lit le message que sur l'entrée standard ; la
  première implémentation passait par un script shell constant. Le lanceur de
  processus accepte désormais `stdin` et la vérification n'utilise plus de
  shell.
- Les sidecars (`recipe.lock.json`) étaient listés comme des dossiers ; le
  listing ne reconnaît plus que le motif d'identifiant.
- Bun applique le seuil de couverture par fichier et par fonction : deux
  callbacks `catch` jamais exécutés bloquaient le gate ; remplacés.
- Les dossiers v1 sans `redactions`/`environment` faisaient échouer le
  résumé ; normalisés à la lecture.
- Un run interrompu restait `conformant` (contrôle annulé non requis) :
  corrigé au plan 1, confirmé ici.

## 5. Non vérifié

- Job CI réel (aucun dépôt distant) : seules ses commandes ont été rejouées
  localement.
- Signature Sigstore sans clé ; clés SSH avec passphrase.
- Mode RPC de Pi.
