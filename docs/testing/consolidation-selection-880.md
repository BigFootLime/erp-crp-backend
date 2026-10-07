# Lisibilité du regroupement — #880 / frontend #1163

Suivi Project Office Test CERP : WP-279. `GET /production/worklist` expose désormais la version PT, l’article et l’empreinte technique réellement figés sur l’OF (sans substitution de version brouillon), les rebuts, les nombres d’événements planifiés et d’opérations engagées, ainsi que son identité de producteur d’un regroupement. Les comptes utilisent les mêmes critères que la lecture des sources de `production-consolidation.repository.ts`.

Le frontend explique les OF incompatibles avant leur sélection. `buildConsolidationPlan` et les commandes d’aperçu/création restent autoritaires et inchangés : PT/version/définition figée, client/article, dossier validé, absence d’engagement et allocations matière. Aucun changement de donnée, migration, permission ou transaction.

Compilation TypeScript et PREPARE/EXPLAIN de la requête complète en transaction annulée ; recette UI commune différée à la fin sur instruction Keenan. Vérifier notamment une autre PT avec le même code affiché, une version différente de la même PT, une gamme modifiée et un événement planifié hors des opérations actuelles. Une page ancienne ne doit jamais permettre de contourner le contrôle serveur.
