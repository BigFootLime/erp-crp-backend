# ADR-0063 — Frontière de fiabilité commerciale

- Statut : accepté
- Date : 2026-08-12
- Décision : SOL-17
- Propriétaire métier : Keenan Martin, Direction CERP+

## Contexte

Le domaine commercial disposait des clients, devis versionnés, commandes, livraisons,
factures et règlements, mais pas d'une preuve commune pour les relances, pertes,
validations de remise et annulations. La conversion pouvait être confondue avec le
statut `ACCEPTE`, les révisions V1/V2 pouvaient compter plusieurs fois une même
opportunité et une marge incomplète pouvait sembler exploitable.

## Décision

Le backend est l'autorité du contrat `CERP-COMMERCIAL-1.0.0`. Il publie les
agrégats, leurs sources et leur fiabilité ; le frontend valide et affiche ce contrat
sans recalcul métier.

### Définitions décisionnelles

| Indicateur | Définition | Unité / période | Source et fiabilité |
|---|---|---|---|
| Facturé client | Factures finalisées de la période, nettes des avoirs finalisés. Il s'agit d'un facturé opérationnel, pas d'un état comptable certifié. | devise HT/TTC, dates de document inclusives | `facture`, `avoir`; `ACTUAL` dans une devise unique |
| Marge proposée qualifiée | Somme des marges `QUOTED` de la dernière version de chaque devis. Le montant est `null` si un seul snapshot est absent ou incomplet. | devise HT, cohorte de création | `margin_recalculations`; au mieux `ESTIMATED`, sinon `PARTIAL` |
| Conversion devis → commande | Nombre de dernières versions de racines de devis reliées par `devis_id` ou `source_devis_version_id` à une commande non annulée, divisé par le nombre de racines émises. | %, cohorte mensuelle | `devis`, `commande_client`, `commande_historique`; `ACTUAL` si le dénominateur existe |
| Délai de réponse | Temps entre le premier événement `SENT` et le premier événement `ACCEPTED` ou `LOST`. | jours, cohorte | `commercial_quote_events`; `PARTIAL` tant que l'historique antérieur n'a pas ces événements |
| Impayé | Solde TTC positif après paiements et avoirs alloués, échu strictement à la date d'arrêté. | devise TTC, `as_of` | `facture`, `paiement_allocations`, `avoir_source_allocations` |
| Backlog | Quantité commandée non expédiée × prix unitaire HT après remise ligne ; les commandes annulées sont exclues. | devise HT, état à `as_of` | `commande_ligne`, `bon_livraison_ligne`, `commande_historique` |
| Risque client | Catégorie explicable, sans probabilité fabriquée : blocage client, impayé échu, commande bloquée, backlog en retard ou devis expiré. | `LOW|MEDIUM|HIGH|CRITICAL` | faits sources listés dans la réponse ; `ACTUAL` ou `PARTIAL` |

Les devis sont dédupliqués par `root_devis_id` et seule la version la plus récente
est retenue. Sans devise explicite, un périmètre multi-devises est refusé avec 409.
Une absence de donnée produit `null` ou une limitation, jamais un zéro de remplissage.
Le fuseau des relances quotidiennes et des bornes métier est `Europe/Paris`.

### Actions et preuves

- les événements de devis et annulations sont append-only ; aucune date historique
  n'est inventée ni rétro-remplie ;
- une remise doit être approuvée pour l'empreinte SHA-256 exacte du contenu avant
  l'envoi du devis ; toute modification invalide donc l'approbation précédente ;
- perte et annulation utilisent des motifs structurés ; une relance identique sur le
  même canal et le même jour est unique ;
- chaque commande sensible porte une clé d'idempotence, une empreinte de requête et
  un reçu rejouable ; réutiliser la clé avec un autre payload retourne 409 ;
- une annulation est refusée après preuve de livraison, facturation ou état terminal ;
- chaque action écrit l'acteur, le propriétaire, la date et un audit dans la même
  transaction ;
- les lectures financières exigent `reporting_financial`. Les décisions de remise,
  expirations et annulations sont réservées à la Direction ou à l'administration ;
  les rôles commerciaux peuvent relancer, enregistrer une perte et demander une
  validation.

La chronologie commande rassemble les sources réelles `commande_client`,
`commande_historique`, `ordres_fabrication`, pointages/déclarations/réceptions de
production, bons de livraison et factures.

## Isolation et limites

L'isolation disponible est celle de la base CERP choisie et validée par le middleware
existant. Les tables commerciales actuelles ne portent pas de société/site
autoritaire commun ; aucun filtre de site fictif n'est donc ajouté. Les événements
antérieurs à SOL-17 restent partiels. Les coûts indirects ou constatés ne sont pas
substitués à la marge proposée : les perspectives industrielles restent gouvernées
par `CERP-MARGIN-2.0.0`.

## Migration et retour arrière

Le patch ajoute trois tables et une fonction de garde, sans réécrire les devis ni les
commandes. Le rollback SQL n'est autorisé que sur une base jetable `test|dev|local`
avec le jeton de session SOL-17 et seulement si aucune preuve commerciale n'existe.
En production, après la première preuve, le retour arrière consiste à redéployer
l'artefact précédent compatible et conserver les tables ; si un retour de schéma est
indispensable, restaurer la sauvegarde complète prise avant la fenêtre.
