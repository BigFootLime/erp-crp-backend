# ADR-0090 — Préparation vérifiable et OF producteurs de regroupement

- Date : 2026-09-05
- Statut : implémenté et validé localement ; revue et activation requises
- Issues : backend #712, frontend #956
- Project Office : CERP / PROD-PREP-GROUP-01 ; journal local en attente de synchronisation API

## Contexte

Les OF issus de commande peuvent précéder une définition industrielle complète. Un assemblage doit déjà exposer ses sous-OF brouillons. Une confirmation manuelle de rubrique ne prouve ni la disponibilité d'un document au bon indice ni l'existence de la matière, du traitement ou de la gamme. Les groupes organisationnels existants ne représentent pas un producteur unique.

## Décision

1. PostgreSQL et les services métier existants restent autoritaires. Les nouvelles routes Production orchestrent les éditeurs PT, gammes, GED, qualité et stock ; elles ne créent aucun référentiel parallèle.
2. La préparation comporte treize exigences calculées. Les preuves communes appartiennent à une révision PT. Une dispense est explicite et motivée. L'examen du stock et la fiche d'autocontrôle sont propres à l'OF et à sa quantité. Une fiche est vierge : aucune mesure ni conformité n'est inventée.
3. La génération activée crée les brouillons racine/enfants sans gamme ni snapshot fictifs. La structure est réconciliée transactionnellement avant validation. Un enfant engagé ne peut pas être modifié silencieusement.
4. La validation fige le snapshot, les preuves et leurs empreintes. Les nouvelles corrections profitent aux brouillons compatibles ; elles ne modifient pas une fabrication déjà figée. Les écritures concurrentes sur le profil et l'OF utilisent les versions attendues.
5. La programmation est explicitement inutile, existante ou confiée à une personne avec une charge estimée. Une tâche à faire permet de préparer le planning ; son achèvement avec une référence réelle est requis pour exécuter.
6. L'attente commence à la création, en heures calendaires, et dépasse le seuil à 48 h exactement. Seule une planification réelle de toutes les opérations supprime l'alerte. Valider ou regrouper ne remet pas le compteur à zéro. Sources couvertes et OF clos ne sont pas comptés deux fois.
7. Un regroupement possède un OF producteur et des affectations immuables aux sources. Même client, article, révision et empreinte technique ; aucun engagement préalable. La quantité est la somme des besoins nets des sources plus un surplus explicite. Le planning ne multiplie pas deux fois la quantité. Le producteur hérite de l'attente la plus ancienne et de la priorité la plus élevée.
8. Les sources couvertes ne peuvent pas être planifiées, pointées, modifiées en quantité ou réceptionnées : les protections SQL s'appliquent également aux anciennes API. Les besoins de composants/réservations sont transférés avec un journal de restitution ; le surplus d'assemblage crée ses propres composants.
9. Une réception physique ne se produit qu'une fois. Les pièces libérées sont affectées aux besoins par échéance, le reste demeure en stock. Une libération qualité ultérieure affecte seulement le delta, sans nouvelle entrée physique. Les allocations cumulées restent limitées au reçu et à la libération du lot.
10. La décision de réemploi conserve l'article et l'indice du lot, réserve le besoin exact, puis réduit le brouillon une seule fois. OLD désigne la provenance historique et ne signifie pas ancien indice. Conformément à ADR-0070 frontend, OLD libéré peut être réservé sans dossier Qualité CERP rétroactif ; NEW/portée inconnue conservent le gate. Un lot bloqué ne devient jamais disponible grâce à cette exception.
11. La dissolution est compensatrice et disponible avant engagement uniquement. Elle conserve l'historique et restitue les besoins/réservations ; aucune suppression de traçabilité.
12. Deux flags indépendants activent le poste de préparation et la création de regroupements. Leur désactivation ne retire ni les protections SQL ni l'accès aux dossiers déjà soumis aux nouvelles règles.

## Frontières et limites explicites

Les statuts commerciaux, AR, BL, facturation et règles de libération qualité restent canoniques. Les demandes futures confirmées sont de vrais OF sélectionnés ; une anticipation sans commande est un surplus motivé, sans commande fictive. La part des quantités n'est pas un coût en euros : le moteur actuel déclare encore ce coût non calculable en l'absence de règles de taux/temps indirect complètes. Les OF d'articles distincts ne sont pas fusionnés ni substitués implicitement.

Les uploads réutilisent les contrôles et droits GED. Les PDF sont téléchargés par une route authentifiée, vérifiés par empreinte et journalisés. Les tâches nominatives et décisions conservent la traçabilité industrielle selon les règles de rétention existantes ; aucun export public ni nouvel appel externe.

## Validation et déploiement

Voir [runbook](../runbooks/production-workbench-712.md) pour précontrôles, patches additifs, vérification et retour fonctionnel. Tests de règles, PostgreSQL réel isolé, suites de régression et parcours Playwright sont détaillés dans le rapport frontend #956. Aucune mesure de performance à l'échelle de production ni activation en production n'est prétendue par cet ADR.
