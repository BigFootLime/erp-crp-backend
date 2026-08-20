# Promotion de release — 20 août 2026

## État

Promotion vers `main` suspendue tant que le contrôle `dev` n'a pas été rejoué après le correctif ci-dessous. Aucune base partagée ni aucun environnement de production n'a été modifié à ce stade.

## Incident du contrôle `dev`

Le contrôle `20260820T065502Z-test-decd72b2-40182c48` a correctement bloqué la promotion. Les 4 848 assertions backend étaient réussies, mais Vitest a détecté une exception asynchrone `EBADF: bad file descriptor, close` rattachée au scénario multipart de création d'un devis.

Cause racine : le test créait un fichier client temporaire puis demandait à Supertest de l'envoyer par chemin. Sous Windows avec Node.js 24 et la concurrence de la suite complète, la résolution de la réponse pouvait précéder la fin de fermeture du `ReadStream` client. La suppression de la fixture entrait alors en course avec cette fermeture. Le pipeline serveur, son stockage privé, la validation du contenu et le transfert transactionnel n'étaient pas en échec.

## Correction

Le scénario envoie désormais le même contenu via un `Buffer` multipart nommé `doc.txt`. Cela conserve le contrat HTTP et tout le pipeline disque sécurisé côté serveur, mais supprime le descripteur client inutile et son cycle de vie asynchrone.

## Preuves après correction

- scénario `devis.routes.test.ts` répété 20 fois : 20 réussites, 0 échec ;
- suite backend complète : 354 fichiers réussis, 3 fichiers conditionnels ignorés, 4 848 tests réussis, 8 conditionnels ignorés, 0 erreur non gérée ;
- `corepack pnpm typecheck` : réussi ;
- `corepack pnpm build` : réussi ;
- contrat OpenAPI : 1 079 opérations inventoriées et contrat émis valide ;
- frontière des données de production : source et build validés.

## Données, compatibilité et retour arrière

Ce correctif ne modifie ni API, ni logique métier, ni schéma, ni donnée. Le retour arrière consiste à annuler le commit de test, mais réintroduirait la course de descripteur Windows. La promotion, les migrations partagées et le déploiement restent soumis aux contrôles de release suivants.
