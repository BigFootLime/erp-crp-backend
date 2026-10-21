# Cumul des fonctions — #1372, 21 octobre 2026

## Suivi et décision

Issue : `BigFootLime/erp-crp-backend#1372` ; frontend associé :
`BigFootLime/crp-systems-web#1627`. Project Office existant :
`CERP / AUTH-SELF-SERVICE-20261016`, suivi local à rapprocher, aucune écriture
Project Office revendiquée. Reprise chantier : cumul de toutes les fonctions.
État local : REVIEW, sections rapport 11/12/16.

Branche : `fix/1372-account-functions-catalog`, issue de `origin/dev` au commit
`49090105`. Objectif accepté : un compte peut cumuler toutes les fonctions
du catalogue ; aucune limite métier arbitraire de 20 fonctions.

## Constat et correction

`approveAccountRequestSchema` et les schémas administratifs refusaient toute
sélection de plus de 20 rôles, alors que le catalogue contient 33 fonctions.
La borne suit désormais `ASSIGNABLE_USER_ROLES.length` : toutes les combinaisons
de fonctions connues passent sans tronquer la sélection. Les valeurs inconnues
restent refusées et la taille des requêtes demeure bornée.

Le sélecteur frontend proposait aussi `Qualité` comme fonction principale alors
que les catégories du catalogue distinguent `PRIMARY` et `ORGANIZATION`.
Le patch SQL existant `20260710_hr_users_role_responsable_rh.sql` conserve une
contrainte `users_role_check` sur les fonctions principales. Cette contrainte
n'est pas élargie : le frontend doit proposer les fonctions `PRIMARY` cochées,
par exemple `Responsable Qualité`, tout en conservant `Qualité` et les autres
fonctions complémentaires dans la sélection. Aucun schéma SQL ne change.

Le schéma d'approbation est réutilisé par l'API et l'annuaire partagé dans
`src/shared-directory/account-request.operations.ts`. Les deux services doivent
donc recevoir le correctif. Le parcours conserve les contrôles de version,
d'idempotence, de sélection de modules et d'autorisation existants.

## Vérification locale

- Reproduction avant correction : erreur `too_big` sur `body.roles`, maximum 20,
  et refus de `Qualité` en fonction principale.
- 43 tests passent dans cinq fichiers : validateurs des demandes, provisioning
  administratif, inventaire OpenAPI, RBAC multi-rôles et frontière d'erreur annuaire.
- Régressions : les 33 fonctions simultanées, chacune des sept fonctions
  principales avec ce catalogue complet, création puis édition du compte,
  conservation des modules et refus des entrées inconnues, vides ou privilégiées.
- `npm run build` passe : compilation TypeScript stricte, inventaire des
  1 600 opérations, validation du contrat OpenAPI et frontière des données de
  production avant et après compilation.
- Les données de test sont synthétiques. Aucune approbation de salarié réel,
  écriture métier, connexion PostgreSQL de recette ou migration n'a été exécutée.

## Préparation de livraison autorisée

Keenan a autorisé le déploiement et la publication du bureau (« aller go »).
Les PR de développement #1401 et de livraison #1402 sont ouvertes. La branche
de livraison reprend le main déployé `860f29da` et exclut les travaux de reprise
de données présents sur dev. Le chantier PIN seul reste dans une livraison
ultérieure, en coordination avec le chantier ISO/RGPD.

Le gate candidat a détecté GHSA-587h-7wmj-h5pm dans le Vite 7.3.6 transitif de
Vitest. Les lockfiles npm et pnpm passent uniquement ce paquet de développement
à 7.3.7 ; le contrat du paquet et les résolutions de production sont identiques.
Le contrôle complet doit être relancé sur le SHA corrigé, sans contournement.
Source : https://github.com/advisories/GHSA-587h-7wmj-h5pm.

Livrer le serveur API et l'annuaire partagé, puis le frontend corrigé et sa
version embarquée Electron. Vérifier le parcours réel après livraison avec
la fonction principale appropriée et tous les modules explicitement souhaités.
Les tests locaux ne constituent pas une preuve de déploiement.

Message de commit proposé : `fix(auth): allow the full account function catalogue`.
