# ADR-0072 — Frontière de facturation électronique et Plateforme Agréée

- Statut : accepté pour le socle ; activation prestataire en attente
- Date : 2026-08-14
- Décideur métier : Keenan Martin
- Périmètre : factures/avoirs B2B et B2G, émission, réception, statuts et preuves
- Référence normative : spécifications externes DGFiP V3.2 du 30 avril 2026

## Contexte

CERP+ sait émettre et figer une facture, mais aucune Plateforme Agréée (PA), aucun
contrat fournisseur, aucun certificat et aucun identifiant de bac à sable ne sont
présents dans les dépôts ou les environnements. Présenter une transmission comme
réussie serait donc trompeur. À compter du 1er septembre 2026, toutes les entreprises
doivent pouvoir recevoir ; les grandes entreprises et ETI doivent aussi émettre et
transmettre leurs données. Cette obligation d'émission s'applique aux PME et
microentreprises le 1er septembre 2027.

Sources officielles :

- https://www.impots.gouv.fr/professionnel/questions/partir-de-quand-suis-je-concerne-par-la-reforme-de-la-facturation
- https://www.impots.gouv.fr/facturation-electronique-et-plateformes-agreees
- https://www.impots.gouv.fr/specifications-externes-b2b
- https://communaute.chorus-pro.gouv.fr/documentation/specifications-externes/

## Décision

### Noyau indépendant du prestataire

- Le domaine CERP+ dépend de `ElectronicInvoiceProviderAdapter`, jamais d'un SDK
  commercial directement. L'adaptateur prépare UBL, CII ou Factur-X, soumet avec
  une clé stable, rapproche un document et vérifie/parcourt un webhook signé.
- Le registre d'adaptateurs est vide par défaut. Une ligne SQL ne suffit pas : le
  connecteur doit être explicitement qualifié, activé, présent dans le binaire et
  correspondre au même environnement. Toute autre combinaison échoue fermée.
- Aucun prestataire, statut, accusé ou preuve de dépôt n'est simulé. L'interface
  affiche `NO_QUALIFIED_PROVIDER` tant que le choix externe n'est pas réalisé.
- Le format entrant est déclaré par le prestataire et validé ; UBL n'est jamais
  supposé par défaut.

### Formats, conformité et immutabilité

- Les formats de frontière sont UBL, CII et Factur-X. Le futur adaptateur doit
  appliquer les schémas et règles de gestion de la version DGFiP qualifiée, puis
  refuser le document avant réseau si une donnée obligatoire manque.
- Seule une facture `ISSUED`, donc légalement numérotée et figée, peut entrer en
  file. L'empreinte SHA-256 de sa source canonique détecte toute divergence.
- CERP+ conserve identifiants prestataire, empreintes, horodatages, tentatives,
  codes 200 à 213, motifs de rejet et références de preuve. Les tentatives,
  événements et reçus d'idempotence sont append-only.
- Les fichiers entrants vivent dans le stockage documentaire sécurisé ; SQL ne
  conserve que leur référence et leur empreinte. Les pièces jointes sont décrites
  par nom, type, empreinte et référence, jamais par leurs octets.

### Idempotence, concurrence et reprise

- La commande utilisateur exige `Idempotency-Key`, liée à l'acteur et à l'empreinte
  exacte de la demande. Réutiliser la clé pour un autre contenu retourne `409`.
- Une facture ou un avoir sortant ne possède qu'un document électronique. La file
  est réclamée par transaction avec `FOR UPDATE SKIP LOCKED` et jeton de traitement.
- La clé transmise au prestataire est stable : `cerp-einvoice-<document UUID>`.
  Un timeout inconnu peut donc être rapproché/rejoué sans créer un second dépôt.
- `429`, timeout et erreurs 5xx suivent un backoff borné à une heure. Les 4xx
  permanentes exigent une correction humaine. Le nombre de retries, la prochaine
  tentative et l'erreur expurgée restent visibles.
- Un événement prestataire est unique par prestataire et identifiant. Le même
  identifiant avec une autre empreinte est un conflit, jamais un nouveau statut.

### Sécurité, audit et confidentialité

- Lecture, soumission, rapprochement et administration technique sont quatre
  capacités distinctes. Les rôles comptables/direction peuvent transmettre et
  rapprocher ; l'administration technique ne donne pas automatiquement le droit
  d'émettre une facture.
- Le webhook public est l'unique route hors authentification applicative. Il reçoit
  les octets bruts et doit être authentifié par l'adaptateur (HMAC, mTLS ou mécanisme
  qualifié), avec fenêtre anti-rejeu. Un corps non signé est rejeté. Un compteur
  PostgreSQL distribué limite en plus chaque adresse IP et échoue fermé si son
  stockage devient indisponible ; il ne remplace jamais la signature prestataire.
- Chaque commande manuelle est auditée avec acteur, requête, corrélation, entité et
  code externe. Les événements automatiques conservent identifiant de requête et
  corrélation. Aucun XML, PDF, token, certificat, email ou contenu d'erreur brut
  n'est journalisé.
- `credential_reference` ne contient que les noms de secrets du coffre ou des
  variables d'environnement. Les valeurs ne sont jamais stockées en base.

## Qualification exigée avant activation

1. Keenan Martin choisit une PA figurant sur la liste officielle et signe le contrat.
2. L'exploitation obtient bac à sable, certificats/secrets, limites et documentation
   versionnée ; les secrets vont dans le coffre HYPERBOX2/Coolify.
3. Un adaptateur dédié est développé et soumis aux fixtures DGFiP, schémas XSD et
   tests contractuels de la PA.
4. Le bac à sable prouve émission, réception, avoir, doublon, timeout après commit,
   rejet, webhooks dupliqués/hors ordre, pièce jointe et rapprochement.
5. Une revue sécurité vérifie signature, rotation, rétention, rate limit, PII et
   absence de journaux documentaires.
6. Seulement après validation, une connexion `sandbox` puis `production` est créée,
   qualifiée par un utilisateur identifié et activée pendant une fenêtre opérée.

## Compatibilité et retour arrière

Le schéma est additif. L'ancien backend ignore les nouvelles tables et le frontend
affiche l'indisponibilité si l'API n'est pas prête. Le rollback applicatif consiste
à désactiver la connexion puis redéployer le SHA précédent en conservant les preuves.
La suppression du schéma est réservée à une base test sans document ; en production,
le retour de schéma se fait par restauration du dump pré-migration dans une base
neuve afin de ne jamais détruire une preuve légale.

## Conséquences

Le produit est prêt à accueillir un prestataire sans verrouillage fournisseur et
sans données fictives, mais il n'est pas juridiquement connecté tant que la PA n'a
pas été choisie et qualifiée. Cette limite est visible et bloquante.
