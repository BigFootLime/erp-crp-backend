# Livraison — accès aux documents archivés (#1102)

## Défaut observé

Sur Base Test, le BL fictif BL-00000048 possède un dossier qualité figé et
un pack PDF v1 généré. Son aperçu retourne « Certains champs sont invalides ».
Les contrôleurs de téléchargement du pack et de documents joints, ainsi que
la suppression d'un document joint, validaient les paramètres avec un schéma
strict ne contenant que `id`. Les paramètres légitimes `documentId` ou `docId`
étaient donc rejetés avant la recherche du document.

## Correction

Valider simultanément l'identifiant du BL et celui du document avec les
schémas UUID stricts correspondant aux routes. Réutiliser le schéma existant
`livraisonDocParamsSchema` pour les documents joints. Le contrôle de liaison
au BL, le téléchargement depuis la racine de stockage autorisée, les droits
des routes et le service audité de suppression restent applicables.

## Vérification ciblée

```sh
node node_modules/vitest/vitest.mjs run \
  src/__tests__/livraison-document-routes-1102.test.ts \
  src/module/livraisons/controllers/livraisons-pdf.controller.test.ts \
  src/module/livraisons/validators/livraisons.validators.test.ts
```

Avant correction : 12 échecs / 9 succès dans les 21 nouveaux contrôles,
avec HTTP 400 sur les routes légitimes. Après correction : **30 / 30 succès**.
Les 21 contrôles de routes utilisent les vrais contrôleurs Express, le vrai
middleware de validation et le vrai expéditeur sécurisé d'un fichier temporaire :
PDF BL et CoFC, téléchargement en pièce jointe, document attaché, transmission
de l'auteur au service de suppression, absence d'utilisateur, UUID incorrect,
paramètres inattendus, document lié à un autre BL, archive absente, chemin hors
racine et refus de suppression d'un document figé.

Deux attentes de code d'erreur du test ont été alignées sur le code canonique
`INVALID_STORAGE_PATH` du téléchargement sécurisé ; sa garde n'a pas changé.

Les dépôts et services métier sont simulés. Ces contrôles ne constituent ni
une validation JWT/RBAC complète, ni un replay PostgreSQL, ni une expédition
réelle. Aucune migration. Le replay du pack v1 déjà archivé sur Base Test doit
suivre le déploiement ; ne pas régénérer les PDF pour masquer le défaut.
