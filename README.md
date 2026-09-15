# pi-evidence — recette et preuves de fonctionnement pour Pi

Package Pi Coding Agent qui exécute les contrôles **déclarés** d'un dépôt
(lint, typecheck, tests, scripts de vérification) et enregistre un dossier de
preuves lié à la révision exacte, à la recette exécutée et à l'identité du
modèle de la session. Le verdict distingue **conformité aux critères déclarés**
et simple **absence de problème détecté**.

Phrase de contrat : dans une session Pi ouverte sur un dépôt, après un
changement, l'utilisateur tape `/evidence run` (ou le modèle appelle
`evidence_run` avant d'annoncer un travail terminé) et obtient un dossier
`.evidence/<id>.json` vérifiable : révision, état de l'arbre, recette, commandes
exactes, codes de sortie, durées, empreintes des sorties, identité du modèle,
verdict `conformant` / `failed` / `incomplete` / `unverified`.

Complément du skill gouverné `verify-runtime` (preuve à la surface exposée,
qui refuse de rejouer tests et lint) : ici, ce sont précisément les contrôles
déclarés qui sont exécutés, et leur résultat est lié, pas seulement affirmé.

## Versions vérifiées

Pi Coding Agent 0.84.2 (`@earendil-works/pi-coding-agent`), Bun 1.4.0, Node
26.8.2, macOS 15. Aucune autre version vérifiée ; voir `docs/RECETTE.md`.

## Installation

Profil isolé ou profil courant, au choix :

```sh
pi install /chemin/absolu/vers/pi-evidence      # par chemin local
pi install ./pi-evidence-0.1.0.tgz              # depuis l'archive produite par `bun run pack`
pi list                                          # doit lister le package
```

Retrait : `pi remove <même source>`. Les dossiers de preuves déjà écrits dans
`.evidence/` des dépôts restent en place (JSON lisible, schéma
`docs/evidence.schema.json`).

## Usage

| Déclencheur | Effet |
| --- | --- |
| `/evidence run [id,id…]` | exécute la recette (ou seulement les contrôles listés), écrit le dossier, affiche le verdict |
| `/evidence status` | dossiers existants, dernier verdict |
| `/evidence show [id]` | détail d'un dossier (défaut : le dernier) |
| `/evidence verify [id]` | rejoue la recette et compare : `reproduced`, `diverged`, `stale` |
| `/evidence config` | recette effective (déclarée ou découverte) et critères |
| `/evidence help` | aide |
| Outils modèle `evidence_run`, `evidence_status` | même logique, mêmes contrôles |

### Recette déclarée : `.evidence.json` à la racine du dépôt

```json
{
  "schema_version": 1,
  "checks": [
    { "id": "lint", "command": "bun", "args": ["run", "lint"], "required": true },
    { "id": "test", "command": "bun", "args": ["test"], "required": true, "timeout_seconds": 900 }
  ]
}
```

Sans fichier, la recette est **découverte** : scripts `lint`, `typecheck`,
`test`, `check` de `package.json` (via `bun run` si `bun.lock` existe, sinon
`npm run`), `cargo test` si `Cargo.toml` existe. Une recette découverte ne
déclare aucun critère : le meilleur verdict possible est `unverified`.

### Verdicts

| Verdict | Signification |
| --- | --- |
| `failed` | au moins un contrôle exécuté a échoué ou dépassé son délai |
| `incomplete` | aucun échec, mais un contrôle requis n'a pas pu être exécuté (commande absente, annulation) |
| `conformant` | critères déclarés, tous les contrôles requis passés, aucun échec |
| `unverified` | aucun critère déclaré ; les contrôles découverts sont passés : « aucun problème détecté », pas une conformité |

Un verdict n'est jamais `conformant` par défaut : il faut une recette
déclarée avec au moins un contrôle `required`.

## Ce qui est lié dans un dossier

- Révision : `HEAD`, branche, liste des fichiers modifiés/non suivis, empreinte
  SHA-256 de `git diff HEAD` et de `git status --porcelain`.
- Recette : empreinte canonique des contrôles (id, commande, arguments, requis,
  délai) ; origine `declared` ou `discovered`.
- Par contrôle : commande et arguments exacts, code de sortie, statut, début,
  durée, empreintes SHA-256 de stdout et stderr, dernières lignes inline,
  journaux complets dans `.evidence/<id>/`.
- Session : identifiant de session Pi, fournisseur, modèle, niveau de
  réflexion ; versions de `bun`, `node`, `cargo` si présents.

## Sécurité

- Exécuter la recette d'un dépôt exécute le code de ce dépôt (ses scripts,
  ses tests) avec les droits du processus Pi : même confiance que le
  développeur qui lance `bun test`. Ne pas lancer sur un dépôt non approuvé.
- Commandes et arguments sont des tableaux ; aucune chaîne shell n'est
  interprétée. Un `command` contenant un séparateur de chemin ou un espace est
  refusé.
- Les journaux capturent la sortie brute des contrôles : un test qui imprime un
  secret le laisse dans `.evidence/`. Le répertoire n'est pas ajouté
  automatiquement à `.gitignore` ; décider explicitement avant de commiter.
- Aucune télémétrie, aucun accès réseau propre au package ; les contrôles
  eux-mêmes peuvent en faire.

## Limites

- Un dépôt sans git est refusé : sans révision, pas de preuve.
- Sources de découverte : `package.json` et `Cargo.toml` seulement.
- Exécution séquentielle ; un contrôle par processus ; pas de sandbox ajoutée.
- L'annulation (Échap) arrête le contrôle en cours (`aborted`) et saute les
  suivants (`skipped`) ; le dossier partiel est écrit avec verdict `incomplete`.

## Licence

Apache-2.0. Aucun code tiers repris.
