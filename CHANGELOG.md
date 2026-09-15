# Changelog

## 0.2.0 — 2026-09-15

- Format de dossier v2 : identité de dépôt sans chemin machine (`repository.name`,
  `repository.origin`), journaux relatifs au répertoire de sortie, exigence,
  environnement, différentiel, caviardages. Les dossiers v1 restent lisibles.
- Deux portes avant exécution : projet approuvé par Pi et recette acceptée par
  une personne (`.evidence/recipe.lock.json`).
- Attestation in-toto v1 et enveloppe DSSE signée SSH ; vérification par
  `allowed_signers`.
- CLI (`bin/evidence.ts`) et workflow `evidence-replay` avec protocole de
  commit de preuves (`verify --ci`).
- Différentiel base/candidat, empreinte d'environnement, acceptation signée en
  sidecar, caviardage des journaux, `prune`, `init`, garde de fin de tour.

## 0.1.0 — 2026-09-15

- Première version : recette déclarée ou découverte, dossier lié à la révision
  et au modèle, verdicts `conformant` / `failed` / `incomplete` / `unverified`,
  rejeu comparé, commande `/evidence` et outils `evidence_run`, `evidence_status`.
