# Éléments non intégrés au gate SOL-06

Cette liste sépare explicitement la dette historique des changements SOL-06 livrables. Aucun de ces éléments n'a été masqué par un test désactivé ou une validation assouplie.

| Élément | Preuve | Pourquoi il n'est pas modifié dans SOL-06 | Impact | Prochaine action, propriétaire et échéance |
|---|---|---|---|---|
| 25 patches récents sans triplet complet preflight/verify/rollback | Liste fichier par fichier dans `MIGRATION_INVENTORY_SOL_06.md`, lignes « Couverture auxiliaire récente incomplète » | Réécrire les patches déjà enregistrés changerait leurs SHA-256. Ajouter 25 contrats rétroactifs sans reconstituer chaque version intermédiaire dépasserait le périmètre sûr de cette migration. Le preflight et l'intégrité globaux contrôlent néanmoins l'état final. | Une restauration ciblée patch par patch n'est pas démontrée pour ces historiques ; la restauration complète reste le rollback supporté. | Backend/DBA CERP+ : créer les supports par domaine et répéter chaque version intermédiaire avant le **2026-08-21**. |
| 10 contraintes `CHECK NOT VALID` historiques | `MIGRATION_REHEARSAL_SOL_06.json`, champ `after.unvalidated_constraints` | `VALIDATE CONSTRAINT` peut scanner des tables volumineuses et doit disposer d'un budget de verrou/IO mesuré sur une copie volumétrique. Aucune FK non validée n'a été acceptée. | Les nouvelles écritures respectent les checks, mais les lignes historiques ne sont pas encore certifiées par PostgreSQL. | Backend/DBA CERP+ : mesurer puis valider par lots avant le **2026-08-21** ; bloquer la release si une violation est trouvée. |
| Volumétrie de production non copiée | Répétition locale : 36 199 447 octets, 364 tables, chaîne complète de 139 patches avant SOL-06 | Les règles interdisent l'accès et la copie implicite de production. La répétition utilise le schéma historique complet et des référentiels déterministes, pas des données réelles. | Les fonctions sont validées fonctionnellement, mais les durées de scan et de verrou à la volumétrie réelle restent à confirmer. | Opérateur release : répéter sur une copie anonymisée de staging et fixer la fenêtre de maintenance **avant toute écriture production**. |

## Patches concernés par la couverture auxiliaire

La liste normative et vérifiable est générée dans `docs/release/MIGRATION_INVENTORY_SOL_06.json` (`recent_support_gaps`). Le Markdown associé expose les 25 noms et les trois indicateurs de couverture afin d'éviter une seconde liste manuelle susceptible de diverger.
