# Changelog

## Non publié

- `attach` : lecture stable de la pièce jointe (refus des liens symboliques,
  borne de 16 Mio, refus si l'identité ou la version du fichier change entre
  inspection, ouverture, lecture et inspection finale) ; la copie stockée est
  écrite depuis les octets empreintés et un nom déjà attaché est refusé, au
  lieu d'être écrasé sous une empreinte qui ne lui correspond plus.
- Verdict de rapport : seule une ligne entière compte ; un verdict cité dans
  la prose, la ligne de gabarit non remplie du skill `verify-runtime` ou deux
  verdicts contradictoires donnent `UNKNOWN`.

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
