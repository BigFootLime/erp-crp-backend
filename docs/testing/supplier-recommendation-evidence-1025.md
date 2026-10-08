# Sources des recommandations fournisseurs — #1025

Extension additive de la lecture existante `GET /production/ofs/:id/supplier-recommendations`.
Le contexte retourné identifie l’OF, son `updated_at`, la version technique choisie,
l’article et la quantité/unité/devise demandées pour la comparaison. Cette quantité
est un paramètre d’estimation, jamais une réservation ou une commande engagée.

La politique `supplier-history-v2` explicite les pondérations existantes : prix 40,
habitudes de commandes envoyées 30, délai médian reçu 15 et évaluation 15. Sans droit
de prix, ce critère vaut zéro et les trois autres sont normalisés sur 60. Les points
sont arrondis à six décimales pour l’explication ; le score et l’ordre existants
restent inchangés. Le score est un classement, pas une probabilité ni la confiance.
Homologation, réserves Qualité et connaissance des exigences restent prioritaires.

Chaque candidat porte les références effectivement consultées : dernière commande
envoyée de l’article, catalogue et version applicables, dernières évaluations
valides. Un tarif indiqué « comparable » couvre seulement une ligne avec forfait,
minimum et conditionnement, hors transport ; aucune conversion ou devise inventée.
L’empreinte SHA-256 décrit ce contexte et ces preuves affichées, sans horloge de
consultation ni prix caché. Elle ne remplace aucun contrôle d’engagement existant.

Le snapshot PostgreSQL 17 reste REPEATABLE READ / READ ONLY : timeout SQL de deux
secondes et transaction de neuf secondes. Quarante fournisseurs, quatre cents
catalogues ; trop de preuves Qualité provoque une erreur explicite, sans homologation
déduite d’une lecture tronquée. Le GET porte `Cache-Control: no-store`.

Cette extension réutilise les données locales ERP. Elle ne configure pas Ollama,
ne charge pas de modèle et ne transmet aucune donnée métier à un service externe.
Le service/modèle de l’extension IA générative locale reste à préciser séparément.

## Recette finale commune — NON EXÉCUTÉE

1. Article exact et bonne version OF ; absence d’achat applicable refusée.
2. Quantité/unité/devise identiques au contexte demandé ; changement de version détecté par l’interface.
3. Historique de commandes envoyées ; brouillons et lignes annulées exclus.
4. Réceptions partielles exclues du délai médian reçu ; jours calendaires expliqués.
5. Prix catalogue comparable avec forfait/minimum/conditionnement ; transport absent expliqué.
6. Absence de prix/historique : aucun recommandé inventé, choix manuel conservé.
7. Rôle sans droit de prix : montants et contribution de prix absents.
8. Homologation/agrément client bloquant prioritaire au score ; évaluation non satisfaisante exclue.
9. Références de commande/catalogue/évaluation et empreinte cohérentes, consultation sans écriture.
10. Erreur SQL/timeout : écran indisponible, choix manuel accessible, aucune donnée obsolète proposée.
11. Limitations de volume explicites ; qualification incomplète non traitée comme valide.
12. Cache et sources séparés par base/utilisateur/rôle ; changement de base en vol.

Quatre fixtures de domaine sont préparées et typées, NON EXÉCUTÉES conformément à
la demande de l’utilisateur. TypeScript/build/OpenAPI et compilation SQL constituent
les contrôles techniques autorisés maintenant. Captures et essais métier/RBAC/UI
seront réalisés à la recette finale groupée.
