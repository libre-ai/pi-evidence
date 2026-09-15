# pi-evidence — recette et preuves de fonctionnement pour Pi

Package Pi Coding Agent (version 0.2.0), avec CLI et job CI, qui exécute les contrôles
**déclarés** d'un dépôt et enregistre un dossier de preuves lié à la révision
exacte, à l'état de l'arbre, à l'environnement, à la recette et à l'identité du
modèle de la session, attesté au format in-toto et signé quand une clé est
disponible. Le verdict distingue **conformité aux critères déclarés** et
simple **absence de problème détecté** ; le différentiel distingue régression
et échec préexistant ; l'acceptation humaine et les rapports de vérification
runtime s'y rattachent sans altérer l'attestation du run.

Phrase de contrat : dans une session Pi ouverte sur un dépôt approuvé, après un
changement, l'utilisateur tape `/evidence run` (ou le modèle appelle
`evidence_run` avant d'annoncer un travail terminé, ou la garde de fin de tour
le lui demande) et obtient un dossier `.evidence/<id>.json`, sa déclaration
in-toto `<id>.intoto.json`, son enveloppe DSSE signée `<id>.dsse.json`, et un
verdict `conformant` / `failed` / `incomplete` / `unverified`. Le même dossier
se rejoue en CI (`evidence gate`, `evidence verify --require-reproduced`).

Complément du skill gouverné `verify-runtime` (preuve à la surface exposée) :
son rapport s'attache au dossier (`evidence attach --kind verify-runtime`).

## Versions vérifiées

Pi Coding Agent 0.84.2 (`@earendil-works/pi-coding-agent`), Bun 1.4.0, Node
26.8.2, OpenSSH `ssh-keygen` 10.3, git 2.55, macOS 15. Voir `docs/RECETTE.md`
et `docs/RECETTE-2.md`.

## Installation

```sh
pi install git:github.com/libre-ai/pi-evidence                   # depuis GitHub
pi install /chemin/absolu/vers/pi-evidence                        # par chemin local
tar -xzf libre-ai-pi-evidence-0.1.0.tgz && pi install "$PWD/package"   # depuis l'archive de `bun run pack`
pi list
```

Un chemin vers l'archive `.tgz` elle-même est accepté par `pi install` mais
l'extension ne se charge pas : extraire d'abord. Retrait : `pi remove <même
source>`. CLI sans Pi : `bun bin/evidence.ts <commande>` (ou le binaire
`evidence` une fois le package installé avec npm/bun).

## Deux portes avant toute exécution

Exécuter une recette exécute le code du dépôt avec vos droits. Deux contrôles,
tous deux exécutés en code, jamais par simple consigne :

1. **Projet approuvé** (Pi) : `/evidence run` et `evidence_run` refusent si le
   projet n'est pas approuvé (`/trust`, ou `pi -a`).
2. **Recette acceptée** : la première exécution et toute modification de la
   recette exigent une acceptation par une personne, mémorisée dans
   `.evidence/recipe.lock.json` (empreinte, date, qui). En TUI, une
   confirmation s'affiche ; le modèle ne peut jamais accepter une recette à
   votre place ; en CLI, `evidence accept --by NOM` ou `--accept-recipe --by`.

## Usage

| Déclencheur | Effet |
| --- | --- |
| `/evidence run [ids] [--requirement RÉF] [--base RÉF]` | exécute la recette, écrit dossier et attestation, affiche le verdict ; `--base` ajoute le différentiel |
| `/evidence status` | dossiers existants, verdict, révision, état de signature |
| `/evidence show [id]` | détail : contrôles, raisons, différentiel, attestation, pièces jointes, décisions |
| `/evidence verify [id]` | rejoue la recette et compare : `reproduced`, `diverged`, `stale` |
| `/evidence config` | recette effective, critères, politique de garde, état d'épinglage |
| `/evidence accept` | accepte la recette courante |
| outils modèle `evidence_run` (`only`, `requirement`, `base_ref`), `evidence_status` | même logique, mêmes portes |
| CLI `evidence run\|gate\|verify\|compare\|status\|show\|config\|accept\|init\|attach\|decide\|prune` | tout ce qui précède hors Pi, `--json` pour la CI |

### Garde de fin de tour

À la fin de chaque tour, si l'arbre de travail a changé et qu'aucun dossier ne
correspond à son état exact : politique `remind` (défaut) → message visible ;
`require` → message de suite demandant au modèle d'appeler `evidence_run` ;
`off` → rien. Réglage : `"policy"` dans `.evidence.json`. Une seule alerte par
état d'arbre.

### Recette déclarée : `.evidence.json`

```json
{
  "schema_version": 1,
  "policy": "remind",
  "checks": [
    { "id": "lint", "command": "bun", "args": ["run", "lint"], "required": true },
    { "id": "test", "command": "bun", "args": ["test"], "required": true, "timeout_seconds": 900 }
  ]
}
```

`evidence init` écrit cette recette depuis la découverte, tous les contrôles
non requis : déclarer les critères est une décision, pas un défaut. Sans
fichier, la recette est découverte : script `check` de `package.json` s'il
existe (il compose les autres), sinon `lint`, `typecheck`, `test` ; `cargo
test` si `Cargo.toml` existe. Une recette découverte ne déclare aucun critère :
verdict `unverified` au mieux.

### Verdicts

| Verdict | Signification |
| --- | --- |
| `failed` | au moins un contrôle exécuté a échoué ou dépassé son délai |
| `incomplete` | aucun échec, mais exécution interrompue, contrôle requis indisponible, sous-ensemble de la recette, ou arbre modifié pendant l'exécution |
| `conformant` | critères déclarés, tous les contrôles requis passés, aucun échec, aucune interruption |
| `unverified` | aucun critère déclaré ; « aucun problème détecté », pas une conformité |

Avec `--base RÉF`, chaque contrôle est aussi exécuté sur la révision de base
dans un worktree détaché (retiré ensuite) et classé `regression`,
`pre-existing`, `fixed`, `stable` ou `not-comparable`. Le verdict reste celui
du candidat ; le différentiel dit si l'échec est introduit ou hérité.

## Ce qui est lié dans un dossier (format v2)

- Dépôt : nom et URL d'origine (identifiants retirés), jamais un chemin machine.
- Révision : `HEAD`, branche, fichiers modifiés et non suivis, empreintes
  SHA-256 de `git diff HEAD` et de `git status` (répertoire de sortie exclu).
- Environnement : plateforme, architecture, empreintes des lockfiles,
  présence de `node_modules`, empreinte globale ; versions `bun`, `node`,
  `cargo`.
- Recette : empreinte canonique, origine `declared` / `discovered`, contrôles
  sélectionnés.
- Par contrôle : commande et arguments exacts, statut, code de sortie, début,
  durée, empreintes SHA-256 des sorties **brutes**, dernières lignes et
  journaux **caviardés** (jetons, clés privées, mots de passe, assignations),
  familles caviardées comptées.
- Session : identifiant, fournisseur, modèle, niveau de réflexion ; exigence
  traitée (`--requirement`).
- Attestation : déclaration in-toto v1 (sujet = HEAD + empreintes d'arbre,
  prédicat = dossier), enveloppe DSSE signée `ssh-keygen -Y sign` avec la clé
  de `EVIDENCE_SSH_KEY` ou de git (`gpg.format=ssh`, `user.signingkey`) ;
  vérification `ssh-keygen -Y verify` avec `EVIDENCE_ALLOWED_SIGNERS`. Sans
  clé : attestation écrite, déclarée non signée.
- Acceptation (sidecar `<id>.acceptance.json`, jamais dans l'attestation) :
  rapports attachés avec verdict extrait (`PASS`, `FAIL`, `BLOCKED`, `SKIP`)
  et décisions humaines signées.

Schéma : `docs/evidence.schema.json` (validé par les tests).

## CI

`.github/workflows/evidence-replay.yml` : sur chaque pull request, accepte la
recette commitée pour le run, exige `conformant` (`evidence gate`), puis
rejoue et compare avec la preuve **commitée** (`evidence verify --ci`).

Un dossier ne peut pas être commité dans la révision qu'il atteste (le commit
changerait `HEAD`). Protocole de **commit de preuves** : après le commit de
code X, exécuter `evidence run`, puis commiter uniquement `.evidence/*.json`
(dossier, attestation, sidecar) dans un commit X+1 qui ne touche rien
d'autre. En CI, quand `HEAD` est un tel commit, les dossiers de son parent X
sont la référence : les arbres sous test sont identiques par construction,
seul `HEAD` diffère. Seuls les dossiers suivis par git comptent comme
référence : le dossier écrit par le job lui-même n'est jamais comparé à
lui-même. Sans référence, l'étape est marquée ignorée ; une comparaison
`diverged` ou `stale` fait échouer le job. Ce dépôt applique ce protocole à
lui-même (`.gitignore` : dossiers et attestations suivis, journaux locaux).

Avec un merge par squash, les commits de la branche disparaissent de `main` :
les dossiers commités y restent des enregistrements historiques dont la
révision est celle du head de la pull request, et la preuve de rejeu vit dans
les checks de cette pull request ("Replay declared recipe", requis). Sur
`main`, `verify --ci` répond « aucune référence » : c'est attendu.

## Sécurité

- Commandes et arguments en tableaux, `command` limité à un nom d'exécutable ;
  aucune chaîne shell interprétée par le package (les recettes peuvent
  déclarer `sh -c …`, c'est ce que l'acceptation engage).
- Les deux portes ci-dessus. Le modèle ne peut ni approuver le projet ni
  accepter une recette.
- Journaux caviardés avant écriture ; les empreintes portent sur le brut.
  Limite : une valeur d'assignation coupée par un saut de ligne ou une clé
  privée de plus de 64 Ko peuvent échapper au flux (pas à `scrubText` sur le
  texte entier).
- Aucune télémétrie, aucun accès réseau propre au package.
- `.evidence/` n'est pas ajouté à `.gitignore` automatiquement : décider quoi
  commiter (le dossier et l'attestation, pas nécessairement les journaux).
  Tant qu'il n'est pas ignoré, un contrôle qui scanne les fichiers non suivis
  (REUSE, scan de secrets) échoue à cause de la preuve elle-même ; le run le
  signale dans ses raisons.

## Limites

- Échap n'annule pas la commande `/evidence run` (Pi 0.84.2 ne transmet pas de
  signal d'annulation à un handler de commande) ; l'annulation du chemin outil
  (`evidence_run`) fonctionne et produit un dossier `incomplete`.
- Différentiel : les dépendances installées sont partagées par lien symbolique
  seulement si les lockfiles sont identiques ; sinon les résultats de base
  peuvent être `unavailable` et la comparaison `not-comparable`.
- Signature SSH seulement (pas de Sigstore sans clé) ; clé avec passphrase non
  supportée ; vérification testée avec OpenSSH 10.3.
- Sources de découverte : `package.json`, `Cargo.toml`.
- Mode RPC de Pi non vérifié sur cette machine.

## Licence

Apache-2.0. Aucun code tiers repris.
