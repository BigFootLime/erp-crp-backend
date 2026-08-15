# ADR-0082 — Frontière société/site et identité d'entreprise

- Statut : accepté pour le modèle actuel ; extension conditionnelle
- Date : 2026-08-15
- Décideur produit : Keenan Martin
- Périmètre : sociétés, sites, SSO et SCIM

## Contexte et preuve

SOL-37 autorise cette évolution seulement pour plusieurs clients ou un client
multi-site avec un besoin contractuel. Aucun contrat de ce type, fournisseur
d'identité, protocole OIDC/SAML, domaine, groupe ou endpoint SCIM n'est déclaré.

La production est une instance dédiée. Elle contient quatre `warehouses` et cinq
`magasins`, qui sont des périmètres logistiques. L'inventaire du catalogue PostgreSQL
ne trouve aucune table `tenant`, `company`, `organization`, `societe` ou `site`, ni
aucune colonne `tenant_id`, `company_id`, `organization_id`, `societe_id` ou
`site_id`. Un filtre `site_id` utilisé par un indicateur de Direction désigne un
entrepôt source ; il ne constitue pas une frontière d'autorisation.

## Cartographie de propriété actuelle

| Domaine | Propriété autoritaire actuelle | Limite |
|---|---|---|
| société légale | instance et configuration de déploiement | aucune entité société en base |
| utilisateurs, rôles et numérotations | instance entière | aucune partition société/site |
| stocks et emplacements | `warehouse → magasin → emplacement` | logistique, pas identité juridique |
| calendriers, centres de coûts et taux | référentiels versionnés de l'instance | pas de rattachement universel à un site |
| ventes, achats, production et qualité | instance entière, liens métier explicites | aucune clé société/site commune |
| GED | entité métier et politique documentaire | aucune partition société/site générale |
| reporting | données de l'instance, filtres métier ponctuels | pas de consolidation multi-société |

## Décision immédiate

CERP+ conserve **une instance dédiée par société cliente**. Les magasins et entrepôts
ne deviennent pas artificiellement des sociétés ou des sites de sécurité. Aucun
champ envoyé par le navigateur ne peut choisir une société implicite. Aucun SSO ou
SCIM générique n'est ajouté sans fournisseur d'identité et contrat réels.

Cette option est la plus sûre pour le premier pilote : les frontières réseau, base,
stockage, secrets et sauvegardes restent celles de l'instance. Le reporting entre
instances n'est pas présenté comme disponible.

## Plan conditionnel si le gate est satisfait

1. **Contrat et modèle** : identifier sociétés légales, sites, partages autorisés,
   IdP, groupes, SLA et responsabilité des données.
2. **Spine additive** : créer `organizations` et `sites`, amorcer une organisation et
   un site legacy par instance, puis rattacher côté serveur les écritures nouvelles.
3. **Migration contrôlée** : backfill par domaine avec preflight, sauvegarde, rapports
   d'orphelins et doubles lectures temporaires ; rendre chaque clé obligatoire
   seulement après couverture complète.
4. **Isolation** : dériver le contexte d'un droit serveur, imposer clés étrangères,
   uniques composites et tests de non-fuite. Le changement de contexte est explicite,
   audité et interdit au milieu d'une transaction métier.
5. **Partage/consolidation** : ajouter des tables d'autorisation explicites et des
   read models agrégés ; jamais de fallback vers « toutes les sociétés ».
6. **Identité** : implémenter OIDC ou SAML selon l'IdP contractualisé, valider issuer,
   audience, signature, nonce et claims, puis mapper les groupes vers des rôles
   internes versionnés.
7. **SCIM** : `/Users` et `/Groups` idempotents, désactivation plutôt que suppression,
   rapprochement par identifiant externe immuable, audit et protection anti-rejeu.
8. **Compatibilité** : qualifier une instance dédiée existante, le changement de
   contexte, le reporting consolidé et chaque route sensible avant activation.

## Invariant principal

Toute écriture métier future doit recevoir son `organization_id` et son `site_id`
depuis le contexte d'autorisation serveur. Une valeur absente, ambiguë ou hors droit
échoue avant mutation. Aucun payload client ne peut élargir ce contexte.

## Compatibilité et rollback

La décision actuelle ne change ni runtime ni schéma. Si le plan futur démarre, ses
migrations seront additives et activées par domaine. Avant contrainte obligatoire,
le rollback consiste à désactiver le nouveau contexte et redéployer le binaire
précédent ; après données multi-société réelles, le retour exige restauration dans
une base neuve et réconciliation, jamais suppression de colonnes en place.

## Conséquences

Le produit évite une multi-tenance prématurée tout en fixant l'invariant à respecter
si un contrat la finance. Le prochain jalon est un dossier client/IdP validé, pas une
migration universelle.
