# ADR-0086 — Gouvernance du périmètre produit

- Statut : accepté
- Date : 2026-08-15
- Propriétaire : direction produit CERP+
- Portée : frontend, backend, données, intégrations et exploitation

## Contexte

CERP+ doit servir les flux industriels récurrents sans devenir une juxtaposition de
variantes clients. Une fonction peu utilisée peut coûter durablement en sécurité,
support, migrations, documentation et tests. À l'inverse, une demande spécifique
peut devenir un bon composant produit si son besoin, sa frontière et son financement
sont explicites.

## Décision

Toute évolution passe par la grille `docs/product/FEATURE_ACCEPTANCE_GRID.md` avant
développement. Une fonction est soit :

1. **produit commun**, lorsque le besoin est réutilisable, fréquent et soutenable ;
2. **extension client financée**, isolée par configuration ou contrat stable, sans
   fork de code ni affaiblissement de la sécurité ;
3. **expérience bornée**, désactivée par défaut, avec date et critères de sortie ;
4. **refusée ou différée**, lorsque les preuves ou la capacité de maintenance
   manquent.

Les exigences de sécurité, isolation, qualité de données, observabilité, sauvegarde,
rollback et tests sont des gates : un score commercial ne peut pas les compenser.
Une feature ne peut pas être activée en production par une valeur par défaut ambiguë.

## Non-priorités explicites

Tant qu'un contrat et une preuve d'usage ne les financent pas, CERP+ ne construit
pas :

- une comptabilité générale complète ;
- une paie complète ;
- un multitenant complexe prématuré ;
- une IA prédictive sur des historiques insuffisants ou non qualifiés ;
- des connecteurs IoT/CNC universels ;
- des scènes 3D ou dashboards décoratifs supplémentaires.

Ces sujets peuvent être réévalués par la grille ; ils ne sont ni promis ni activés
par opportunité technique.

## Passage de 3 à 10 puis 20 clients

### Jusqu'à 3 clients pilotes

- une instance dédiée par société reste acceptable ;
- chaque flux vendu a un propriétaire, une preuve E2E, un runbook et un rollback ;
- sauvegarde/restauration, RBAC, audit et prérequis métier sont démontrés ;
- aucune divergence client ne nécessite un fork.

### De 3 à 10 clients

- deux usages indépendants au moins confirment chaque fonction promue au noyau ;
- provisioning, configuration, migration et contrôle de release sont automatisés ;
- coût de support par module, fréquence d'incident et délai de résolution sont mesurés ;
- les extensions restent versionnées, documentées et testées dans la matrice commune ;
- les engagements de disponibilité et de récupération sont contractualisés.

### De 10 à 20 clients

- la frontière organisation/site est réévaluée à partir des contrats réels ;
- capacité, isolation, rotation des secrets, observabilité et reprise sont testées en
  charge représentative ;
- les modules au coût de support disproportionné sont corrigés, tarifés, dépréciés
  ou retirés ;
- le support et les opérations disposent d'une astreinte, d'indicateurs et d'un
  budget compatibles avec le nombre d'instances.

Le franchissement d'un palier est une décision écrite. Le nombre de clients seul ne
constitue pas une preuve de maturité.

## Revue trimestrielle

La direction produit réunit produit, support, sécurité et exploitation. Pour chaque
module elle examine : clients actifs, fréquence d'usage, tickets et temps passé,
incidents, dette de sécurité, coût d'infrastructure, couverture de tests, revenu ou
engagement associé et prochaine décision. Le relevé indique une source, une période,
un propriétaire et une fiabilité ; une absence de mesure reste « indisponible », pas
zéro.

Les décisions possibles sont : maintenir, investir, reconfigurer, tarifer,
déprécier ou retirer. Le cycle de dépréciation est défini dans
`docs/product/EXTENSION_LIFECYCLE.md`.

## Conséquences

- Les demandes sont arbitrées avant de créer du code ou un schéma.
- Les variantes maintenables utilisent des capacités communes et des configurations
  explicites.
- Les fonctions sans usage prouvé peuvent être retirées de façon annoncée et
  réversible.
- La grille et le relevé trimestriel deviennent des preuves attendues dans les PR
  fonctionnelles significatives.

## Rollback

Cette décision ne modifie aucun runtime. La retirer exige un nouvel ADR expliquant
la gouvernance de remplacement ; supprimer seulement les documents recréerait une
zone de décision implicite.
