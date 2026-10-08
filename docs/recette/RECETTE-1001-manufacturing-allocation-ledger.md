# Recette 1001 — Allocations de coût fabriqué

**Préparée, NON EXÉCUTÉE.** À exécuter dans la recette commune finale sur Base Test, avec données dédiées. Toute activation du projecteur fait partie de cette recette contrôlée ; Production reste PREPARED dans ce lot.

| Cas | Résultat attendu |
| --- | --- |
| Base déclarée 1 EUR / 3 pièces, trois réceptions compatibles | Parts 0.333333333333, 0.333333333334, 0.333333333333 ; une base, trois événements, total 1 |
| Dernière réception et coût nul explicitement connu | Reliquat exact ; zéro uniquement si la base connaît zéro |
| Nouvelle tentative, reprise du worker ou crash entre écritures | Un événement par entrée ; budget/valeur/cursor global atomiques |
| Deux workers concurrents | Un seul consommateur actif ; aucun double coût |
| Base absente, PT/version différente, quantité dépassée ou curseur corrompu | Coût inconnu avec cause ; aucune allocation partielle conservée |
| Stock client, unités/devise non prises en charge ou propriétaires multiples | Aucune valeur entreprise inventée, aucun budget entreprise consommé |
| Annulation de la première réception après la seconde | Restitution exacte du montant original ; budget net cohérent |
| Annulation partielle, puis annulation d'annulation | Montants d'origine proportionnés par le journal de retour et réappliqués exactement |
| Réallocation après annulation, puis nouvelle annulation | Plafonds nets de quantité/valeur respectés ; pas de cumul brut erroné |
| Arbre d'inverse trop profond, faux parent ou dépassement | Valeur inconnue ; rollback conjoint des allocations de retour/fabrication |
| Suppression, modification, troncature ou faux lien d'événement | Gardes immuables et différées refusent le commit |
| Indisponibilité SQL / timeout | Transaction financière abandonnée et réessayable ; stock physique déjà validé conservé |
| Réception physique sans preuve financière | Flux physique autorisé ; coût explicitement inconnu |
| Préflight/verify/replay des migrations | Une application par base, zéro pending/checksum/replay ; backup conservé |

Les fixtures d'adaptateur `cump-manufacturing-ledger.repository.test.ts` sont préparées. Elles ne prouvent pas l'exécution des transactions ni des gardes PostgreSQL : ces preuves appartiennent à la recette finale réelle.
