# ADR-0071 — Frontière administration, notifications et imports

- Statut : accepté
- Date : 2026-08-14
- Décideur : Keenan Martin
- Périmètre : provisioning existant, revues d’accès, notifications applicatives et assistant d’import

## Contexte

Le provisioning administratif et les droits nominatifs existaient déjà, mais ils
n’étaient pas réunis avec une revue périodique traçable. Les administrateurs ne
disposaient pas d’un instantané stable des comptes privilégiés ou inactifs, des
échecs de connexion et des autorisations exceptionnelles. Une correction de droit
prise pendant la revue aurait donc modifié la preuve examinée.

Les notifications pouvaient être lues et dédupliquées, mais leur cible métier,
leur expiration, leur mise en sourdine, leur escalade et l’autorisation réelle de
l’action n’étaient pas explicites. L’assistant d’import possédait déjà staging,
mapping, simulation, reprise et idempotence, sans contrat agrégé fiable pour le
funnel et le Pareto des erreurs.

## Décision

### Comptes et revue d’accès

- Le panneau d’administration existant reste la frontière unique de provisioning,
  activation, désactivation, réinitialisation et droits. SOL-25 n’ajoute aucun
  parcours public et ne déplace aucune autorité vers le frontend.
- Une revue est ouverte manuellement, au plus une à la fois. La création exige une
  clé d’idempotence, est sérialisée par verrou transactionnel et protégée aussi par
  un index unique partiel.
- La revue photographie tous les comptes. Une décision ultérieure ne recalcule pas
  silencieusement les signaux et ne modifie jamais le compte ou ses droits.
- Seul un superadministrateur peut lister, ouvrir, décider et clôturer une revue.
  Le rôle métier `Directeur` ne suffit pas.
- Une correction ou une exception exige une justification. Une décision est
  unique, idempotente et auditée dans la même transaction. La clôture est refusée
  tant qu’un compte reste sans décision.
- `PRIVILEGED` signifie `is_superadmin` ou rôle `Administrateur Systeme et Reseau`
  / `Directeur`. `INACTIVE` signifie aucun login réussi depuis le seuil, avec la
  date de création comme repli de classification. `FAILED_LOGIN_BURST` compte les
  échecs rattachés au compte dans la fenêtre. `EXCEPTIONAL_ACCESS` signifie au
  moins un `GRANTED` explicite sur un module désactivé par défaut. `BLOCKED`
  provient du statut du compte.
- Le risque est `HIGH` pour compte bloqué, rafale d’échecs ou compte privilégié
  inactif ; `MEDIUM` pour tout autre signal ; `LOW` sans signal. Ce classement est
  une aide à la décision, jamais une sanction automatique.

### Notifications

- Une notification peut porter `entity_type`, `entity_id`, `action_key`,
  `module_key`, expiration, sourdine et niveau d’escalade. Entité et identifiant
  sont indissociables, et toute URL d’action doit être interne.
- La liste exclut par défaut les notifications expirées ou encore en sourdine.
  Les compteurs distinguent non lues, sourdes et expirées.
- Avant de renvoyer une action, le serveur résout le profil d’accès du destinataire.
  Un refus, un module inconnu ou une infrastructure d’autorisation indisponible
  supprime l’URL côté API. La route cible conserve son propre RBAC : la notification
  n’est jamais une autorisation.
- Lecture, sourdine et escalade restent limitées à `user_id` issu du jeton. Sourdine
  et escalade sont auditées sans titre, message ni payload. L’escalade est monotone
  de 0 à 5 ; un retry ne la réduit pas.
- Le message temps réel conserve son contrat version 1 minimal. Les nouveaux champs
  vivent dans la base et l’API ; le client recharge la liste après l’événement.
  Cela préserve la lecture des événements historiques.

### Imports

- Les primitives existantes restent l’autorité : fichier en mémoire contrôlée,
  staging, mapping, simulation, lignes acceptées/rejetées/dupliquées, crosswalk,
  confirmation idempotente, reprise des lignes interrompues et rapport CSV.
- Le nouvel agrégat `/api/v1/import-assistant/metrics` est réservé aux rôles
  d’import existants et à `cerp_test`. Il ne déclenche aucune écriture.
- Funnel, unité `rows`, période UTC filtrée sur `data_import_batches.created_at` :
  `UPLOADED` = toutes les lignes ; `VALIDATED` = hors `PENDING` ; `ACCEPTED` =
  `VALID|PROCESSING|IMPORTED|LINKED|ALREADY_IMPORTED` ; `REJECTED` =
  `BLOCKED|DUPLICATE|FAILED` ; `DUPLICATE` est un sous-ensemble ; `IMPORTED` =
  `IMPORTED|LINKED|ALREADY_IMPORTED`.
- Source : `data_import_batches` et `data_import_rows`. Fraîcheur : dernier
  `updated_at` de lot. Fiabilité : `UNAVAILABLE` sans lot, `PARTIAL` avec lot en
  cours, sinon `VERIFIED`. Le Pareto compte les codes présents dans `issues`, avec
  lots affectés et dernière occurrence.
- Le CSV neutralise `=`, `+`, `-` et `@` en tête de cellule pour empêcher
  l’injection de formule tout en conservant la référence corrigeable.

## Sécurité, isolation et données

Les identifiants de compte et d’entité sont des références métier non sensibles.
Les audits ne recopient ni secrets, ni messages de notification, ni lignes importées.
Le schéma actuel ne porte pas de dimension société/site exploitable sur ces objets ;
aucune isolation multi-société fictive n’est revendiquée. Les exports d’import et
les journaux restent derrière authentification et RBAC existants.

## Migration et retour arrière

`20260814_admin_operations_sol25.sql` est additif et rejouable. Il crée deux tables
de preuve et enrichit `app_notifications`; il ne crée, ne supprime, ne désactive et
ne modifie aucun compte ou droit. L’ancien binaire ignore ces objets.

Le rollback normal consiste à redéployer l’ancien binaire en conservant le schéma.
La suppression physique exige `cerp.allow_destructive_rollback=on` et ne doit être
faite qu’après export des décisions. Dès qu’une preuve réelle existe, restaurer le
dump pré-migration dans une base neuve est la stratégie de retour de schéma.

## Conséquences

La revue doit être ouverte et traitée par un humain, par exemple chaque trimestre ;
aucune désactivation risquée ne sera automatique. Une action de notification peut
devenir indisponible si son autorisation n’est pas démontrable, ce qui est volontaire.
L’agrégat d’import prépare le passage UI ultérieur sans introduire de dashboard ou de
donnée de démonstration dans SOL-25.
