# Rapport d'exécution — Adaptateur SUPER PDP

## Résultat

Adaptateur SUPER PDP complet pour une installation dédiée : EN 16931 source-backed, conversion UBL/CII/Factur-X, OAuth coffre-only, dépôt idempotent, reprise après résultat incertain, rapprochement automatique et manuel, RBAC d'administration, audit d'activation et statut officiel sans invention.

Le mode mutualisé multi-entreprise est volontairement bloqué : le modèle actuel ne porte pas encore de `tenant_id` de bout en bout. Les installations séparées pour plusieurs entreprises sont compatibles dès maintenant.

## Diagnostic et cause racine

SOL-26 avait construit la frontière prestataire mais aucun adaptateur n'était enregistré. La table de connexion restait vide et aucun transport réel ne pouvait convertir, déposer ou rapprocher une facture. Le risque secondaire était de confondre les statuts techniques SUPER PDP avec les codes DGFiP.

## Architecture

- interface `SuperPdpAccessTokenProvider` : `client_credentials` dédié maintenant, fournisseur OAuth par société injectable plus tard ;
- secret lu uniquement depuis l'environnement ; SQL conserve les noms de références ;
- `external_id` = UUID CERP+ et recherche préalable pour les retries ;
- conversion distante du modèle EN 16931 validé ;
- seuls `fr:200..213` alimentent la colonne officielle ;
- polling authentifié, webhook fermé faute de contrat d'authenticité qualifié ;
- activation sandbox/production distincte, auditée et idempotente.

## Fichiers et données

Code principal dans `src/module/facturation/electronic-invoicing/providers/super-pdp/`, contrôleurs/services/dépôt SOL-26 adaptés, routes d'administration ajoutées, contrat OpenAPI inventorié, ADR-0087 et runbook ajoutés.

Aucune nouvelle migration et aucune écriture en base de production. L'activation future crée ou met à jour uniquement `super-pdp-sandbox` ou `super-pdp-production` dans la table SOL-26 existante.

## Tests exécutés

- `pnpm typecheck` : réussi ;
- 19 tests ciblés domaine/service/routes/adaptateur : réussis ;
- scénarios adaptateur : conversion, OAuth, absence de fuite du secret, événement officiel, reprise par `external_id`, mode multi-tenant bloqué ;
- `pnpm build` : réussi, 1 072 opérations OpenAPI inventoriées et contrat valide ;
- `pnpm test:run` : suite backend complète réussie (code 0) ;
- `pnpm audit --audit-level high` : aucune vulnérabilité connue ;
- tests ciblés finaux adaptateur + RBAC routes : 12/12 réussis.

## Rollback

Désactiver la connexion dans Administration, retirer `EINVOICE_PROVIDER`, redémarrer le backend et revenir au commit précédent. Conserver les documents, tentatives et événements existants. Aucun rollback SQL destructif n'est requis.

## Restant avant production réelle

- placer le secret que l'utilisateur a copié dans les coffres sandbox Coolify/HYPERBOX2, jamais dans Git ;
- exécuter le smoke test sandbox et un dépôt de facture fictive ;
- terminer KYB Croix Rousse Précision puis répéter la qualification avec des identifiants production ;
- obtenir et qualifier un mécanisme signé SUPER PDP avant d'activer les webhooks ;
- réaliser le chantier tenant/isolation/vault/consentement avant toute instance SaaS partagée.

## Vérification navigateur isolée

Le stack SOL-05 jetable a appliqué les migrations et fixtures dans PostgreSQL temporaire, puis démarré le build courant. Recette : connexion KEENAN fictive, MFA fictif, Administration → Facturation électronique. Résultats : aucun champ secret, diagnostic relançable, activation désactivée sans coffre, zéro erreur console, largeur sans débordement à 1024 px et 390 px. Le stack et la base ont ensuite été détruits.
