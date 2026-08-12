# ADR-0064 — Frontière de fiabilité des achats

- Statut : accepté
- Date : 2026-08-12
- Décision : SOL-18
- Propriétaire métier : Keenan Martin, Direction CERP+

## Contexte

Les commandes fournisseurs, réceptions, contrôles entrants et lots existaient,
mais aucune vue autoritaire ne reliait leurs preuves. La date promise pouvait être
écrasée sans historique, les unités de réception pouvaient être additionnées sans
garantie de conversion et aucune file commune ne portait le responsable d'une
anomalie. Les factures, avoirs et retours fournisseurs ne sont pas modélisés dans
le schéma actuel.

## Décision

Le backend publie le contrat CERP-PROCUREMENT-1.0.0. Le frontend valide ce
contrat et l'affiche sans recalculer les indicateurs.

| Indicateur | Définition | Unité et période | Sources |
|---|---|---|---|
| OTD fournisseur | Engagements arrivés à échéance et reçus intégralement au plus tard à la date promise / engagements arrivés à échéance. | %, cohorte de dates promises incluses entre from et min(to, as_of) | commandes/lignes, historique des promesses, lignes de réception |
| Variabilité du délai | Écart-type population des jours calendaires entre envoi de la commande et réception intégrale. Au moins deux observations sont requises. | jours calendaires, même cohorte | date d'envoi, dates de réception |
| Écart de prix | (Facturé rapproché − commandé) / commandé, pondéré par montant. | % | UNAVAILABLE tant qu'aucune facture/ligne d'avoir fournisseur n'existe |
| Taux de rejet | Quantité normalisée des contrôles décidés BLOQUE / quantité normalisée de tous les contrôles décidés. | % de quantité en unité d'achat | contrôles entrants, réceptions, lots |

Chaque métrique expose définition, unité, période, source, fraîcheur, numérateur,
dénominateur, éléments manquants et fiabilité ESTIMATED, PARTIAL, ACTUAL
ou UNAVAILABLE. Une cohorte vide et une source absente donnent null, jamais
zéro.

## Dates promises, unités et tolérances

- l'accusé fournisseur crée toujours un événement initial
  SUPPLIER_ACKNOWLEDGEMENT, même si la date confirmée est identique à la date
  précédemment prévue ;
- chaque révision ultérieure exige un motif structuré, l'acteur et un verrou
  optimiste sur l'en-tête ou la ligne réellement modifiée ;
- l'historique est append-only. Les promesses antérieures à SOL-18 ne sont pas
  rétro-inventées et abaissent la fiabilité à PARTIAL ;
- une quantité reçue n'est rapprochée que dans la même unité ou avec le
  coefficient explicite stock-par-unité-d'achat. Une quantité source absente ou
  négative provoque une erreur de données, pas un zéro ;
- les tolérances de sur-réception, délai et prix sont datées et append-only par
  société, fournisseur, article ou famille. En l'absence de politique, la
  sur-réception et le délai utilisent une tolérance stricte de zéro ; aucune
  tolérance de prix n'est inventée.

## Rapprochement et anomalies

La réponse relie commande et ligne, réceptions partielles, unité normalisée,
contrôle entrant, lot et documents. Elle détecte quantité manquante ou excédentaire,
réception tardive, unité non convertible, lot bloqué, document absent et contrôle
obligatoire manquant. Chaque anomalie a une clé déterministe, une gravité, les
preuves sources, une action recommandée et une échéance ; l'overlay de traitement
ajoute responsable, prochaine action, statut et motif de clôture.

Les factures, avoirs et retours fournisseurs sont exposés avec
SUPPLIER_*_SOURCE_NOT_MODELLED. Ils ne sont ni simulés ni remplacés par des
valeurs de commande.

## Autorisation, audit et idempotence

Toutes les routes restent derrière l'authentification et le gate de base CERP.
Lecture et prix suivent les capacités achats existantes ; dates promises exigent
acknowledge, traitement d'anomalie close, politique de tolérance approve.
Chaque mutation exige Idempotency-Key, compare l'empreinte du payload, conserve
un reçu rejouable et écrit l'audit central dans la transaction.

## Migration et rollback

Le patch est additif et doit être appliqué avant le nouvel artefact backend, car
l'accusé fournisseur écrit désormais l'événement initial. L'ancienne application
reste compatible avec le schéma enrichi.

Le rollback SQL n'est permis que tant qu'aucune preuve SOL-18 n'existe. Après la
première promesse, politique, action ou commande idempotente, conserver les tables
et redéployer l'artefact précédent. Si un retour de schéma est imposé, arrêter les
écritures et restaurer la sauvegarde complète vérifiée dans une nouvelle base,
puis promouvoir cette base.
