# ADR-0087 — Adaptateur SUPER PDP, authentification et frontière multi-entreprise

- Statut : accepté pour installation dédiée ; activation SaaS multi-entreprise bloquée
- Date : 2026-08-16
- Propriétaire : Keenan Martin
- Décision liée : ADR-0072 / SOL-26

## Contexte

CERP+ doit transmettre des factures structurées via une Plateforme Agréée sans faire passer un statut technique pour un statut DGFiP. L'instance actuelle est dédiée à Croix Rousse Précision, mais le produit pourra être installé chez d'autres entreprises puis, éventuellement, devenir mutualisé.

SUPER PDP publie une API REST avec OAuth 2, conversion EN 16931 vers UBL/CII/Factur-X, dépôt asynchrone et événements de cycle de vie. Deux flux OAuth sont publiés : `client_credentials` pour les données de l'entreprise propriétaire des identifiants et `authorization_code` pour agir après consentement d'une autre entreprise.

## Décision

1. Le cœur SOL-26 reste indépendant du prestataire. L'adaptateur porte la conversion, le transport et le mapping des événements SUPER PDP.
2. Une installation CERP+ dédiée utilise `client_credentials`. Les valeurs restent exclusivement dans le coffre Coolify/HYPERBOX2. SQL ne conserve que les noms des variables.
3. La connexion SQL est nommée `super-pdp-sandbox` ou `super-pdp-production` et référence l'adaptateur `super-pdp`. Cela évite de confondre les deux environnements.
4. `external_id` reçoit l'UUID immuable du document CERP+. Avant un nouveau dépôt, l'adaptateur recherche cet identifiant afin de reprendre un appel dont le résultat était incertain sans créer de doublon.
5. CERP+ ne force pas le paramètre optionnel `processing_rule`. SUPER PDP le calcule et le valide à partir de la facture et de l'annuaire ; imposer `B2B` a été prouvé faux pour un cas `B2BInt`. Les pre-checks synchrones du prestataire restent activés.
6. Le cadre de facturation BT-23 et l'adresse électronique de routage sont des faits métier distincts des identifiants légaux. Tant qu'ils ne sont pas capturés, versionnés et figés dans l'instantané de facture, le système doit bloquer la transmission au lieu de deviner une valeur ; suivi `#599`.
7. Seuls les événements `fr:200` à `fr:213` alimentent le cycle officiel. `api:*`, `ppf:*` et `fr:501` restent des états techniques ou des erreurs ; ils ne fabriquent jamais un statut métier.
8. Les webhooks sont fermés tant que leur mécanisme d'authenticité signé n'est pas publié et qualifié. Un polling authentifié rapproche les documents en attente toutes les cinq minutes.
9. L'activation production exige en plus `SUPER_PDP_PRODUCTION_ACTIVATION_ENABLED=true` après qualification opérateur.

## Frontière multi-entreprise

Le mode partagé `authorization_code` est présent comme interface de jeton injectable, mais son fournisseur par défaut échoue fermé. Il ne pourra être activé qu'après livraison simultanée de :

- `tenant_id` obligatoire sur factures, connexions, événements, commandes idempotentes et audits ;
- politiques PostgreSQL ou dépôts garantissant l'isolation de toutes les requêtes ;
- callback OAuth avec `state`, PKCE, validation stricte de redirection et consentement audité ;
- jetons d'accès/rafraîchissement chiffrés dans un coffre par société, jamais dans la base métier ;
- rotation, révocation, suppression et restauration testées par locataire ;
- tests négatifs prouvant qu'une société ne peut ni voir ni émettre pour une autre.

Jusqu'à cette preuve, plusieurs entreprises sont supportées uniquement par des installations dédiées séparées, chacune avec sa base et ses identifiants SUPER PDP.

## Compatibilité et rollback

Aucune migration SQL supplémentaire n'est requise : les tables SOL-26 suffisent. Pour revenir en arrière, désactiver la connexion via le panneau administrateur, retirer `EINVOICE_PROVIDER=super-pdp`, redémarrer le backend et conserver les preuves déjà enregistrées. Ne jamais supprimer les événements ou tentatives append-only.

## Sources de contrat

- Documentation : <https://www.superpdp.tech/openapi/>
- OpenAPI SUPER PDP : <https://api.superpdp.tech/openapi/superpdp.json>
- Contrat AFNOR Flow : <https://api.superpdp.tech/openapi/xp-z12-013-flow-1.3.0.json>
