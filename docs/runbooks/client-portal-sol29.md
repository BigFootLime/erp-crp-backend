# Runbook — Portail client SOL-29

- Propriétaire : Keenan Martin / administration CERP+
- Version : 2026-08-14
- Gravité : P0 si une donnée d’un autre client est visible ; P1 si connexion, invitation ou document indisponible pour un seul client

## Préparation et configuration

1. Générer un secret aléatoire distinct de `JWT_SECRET`, d’au moins 32 caractères, dans le gestionnaire de secrets de l’environnement. Ne jamais le placer dans Git, un ticket ou un log.
2. Définir `CLIENT_PORTAL_JWT_SECRET` et l’URL HTTPS externe exacte dans `CLIENT_PORTAL_PUBLIC_URL`. Pour l’email, définir `RESEND_API_KEY`, `RESEND_FROM` et, seulement pour une recette locale, `RESEND_API_BASE_URL`.
3. Faire un dump custom chiffré, vérifier son SHA-256 et une restauration isolée. Exécuter le preflight SOL-29 puis appliquer uniquement `20260814_client_portal_sol29.sql` sur `cerp_test` avant `cerp_prod`.
4. Exécuter le verify et le replay de patch. Ne pas ouvrir le portail si une vue, un trigger append-only ou le trigger inter-client manque.

## Exploitation normale

1. Dans **Administration → Portail clients**, créer le compte avec le code client, l’email et le nom du contact. Le compte reste inactif.
2. Envoyer l’invitation. Si l’email indique `NOT_CONFIGURED` ou `FAILED`, copier le lien une seule fois et le transmettre par un canal authentifié ; ne jamais le coller dans un ticket partagé.
3. Le client active sous 24 heures, puis se connecte. Une récupération expire après une heure.
4. Publier seulement une version GED courante, applicable, liée au bon client et antivirus saine. Vérifier le titre public, l’expiration et si un accusé est requis.
5. En cas de départ du contact, suspendre immédiatement. Révoquer si l’accès ne doit jamais être réactivé. Toute action exige un motif exploitable.

## Incident et arbre de décision

- **Suspicion de fuite inter-client** : couper immédiatement les routes `/api/v1/portal` au reverse proxy, conserver logs et audit, ne modifier aucune preuve, classer P0 et lancer une investigation par `request_id`, `portal_account_id` et `client_id`.
- **Jeton volé ou poste perdu** : suspendre le compte. Le changement de `session_epoch` invalide les sessions en cours ; réactiver seulement après vérification du contact et reset du mot de passe.
- **Invitation expirée** : relancer l’invitation avec une nouvelle clé d’idempotence. Ne pas modifier l’expiration SQL.
- **Email absent** : vérifier la configuration Resend et son statut ; ne pas révéler par l’API publique si l’adresse existe.
- **Document en attente/quarantaine** : suivre le runbook antivirus. Ne jamais forcer le statut ni servir directement la clé de stockage.
- **Document remplacé/expiré** : publier explicitement la nouvelle version ou une nouvelle échéance ; ne pas réactiver en base à la main.
- **Erreur d’intégrité SHA-256** : couper le téléchargement du document, préserver le blob, classer P0/P1 selon diffusion et suivre le runbook de corruption.

## Vérifications reproductibles

```powershell
rtk proxy "C:\Program Files\nodejs\corepack.cmd" pnpm vitest run src/module/client-portal src/__tests__/client-portal-isolation.repository.test.ts src/__tests__/client-portal-sol29.migration-guards.test.ts
rtk proxy "C:\Program Files\nodejs\corepack.cmd" pnpm db:migrations:preflight
rtk proxy "C:\Program Files\nodejs\corepack.cmd" pnpm db:migrations:rehearse
```

Depuis le frontend propre :

```powershell
rtk proxy "C:\Program Files\nodejs\corepack.cmd" pnpm test -- src/modules/client-portal
rtk proxy "C:\Program Files\nodejs\corepack.cmd" pnpm e2e:isolated -- e2e/client-portal-isolation.spec.ts
```

Le test E2E doit prouver : anonyme 401, utilisateur standard 403 sur l’administration, invitation expirée, retry/idempotence, deux clients mutuellement invisibles et révocation immédiate.

## Retour au service

- Health/readiness verts sur le SHA déployé.
- E2E d’isolation vert sans retry flaky.
- Un compte de recette peut voir uniquement sa commande et aucun brouillon.
- Un document non sain reste visible comme indisponible mais impossible à télécharger ou accuser.
- Audit de connexion, téléchargement et action administrative présent, sans email, secret ni contenu.

## Rollback

- Avant tout compte/publication/audit : désactiver les routes, redéployer le SHA précédent puis exécuter le rollback support uniquement sur la cible vérifiée.
- Après toute preuve : le rollback SQL refuse volontairement. Désactiver les routes et les comptes, conserver les tables append-only, corriger en migration additive puis redéployer.
- Une restauration de dump se fait dans une nouvelle base isolée ; elle ne remplace jamais directement la production sans décision et fenêtre explicites.

## Actions interdites

Ne jamais changer un `client_id`, supprimer un audit/accusé, marquer un scan sain manuellement, publier une ancienne version par SQL, partager un jeton dans les logs, utiliser le secret ERP pour le portail ni augmenter les limites pour masquer une attaque.
