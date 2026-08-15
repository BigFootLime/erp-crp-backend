# ADR-0076 — Frontière d’identification industrielle versionnée

- Statut : accepté
- Date : 2026-08-14
- Propriétaire : Keenan Martin
- Périmètre : QR codes, Code 128, Data Matrix, impression, scan et reprise hors ligne

## Contexte

Les modules stock, achats, qualité, production, outillage et livraison utilisaient leurs identifiants métier séparément. Encoder ces identifiants, une URL privée ou un secret directement dans une étiquette rendrait une évolution de schéma irréversible, faciliterait l’énumération et dupliquerait la logique métier dans le lecteur.

## Décision

1. Le seul contenu public est `CERP:1:<public UUID>`. Le numéro d’OF, le lot, le client, le site, une URL, un jeton ou un secret ne sont jamais encodés.
2. `identification_labels` est le registre serveur. Une étiquette vise exactement un type et un identifiant métier et porte un état `ACTIVE`, `INVALIDATED` ou `REPLACED`. Une contrainte garantit une seule étiquette active par entité.
3. La résolution vérifie successivement le format, l’existence et l’état de l’étiquette, le type attendu par le flux, le rôle, l’accès au module cible, l’existence de l’entité et son statut métier. Un refus ne révèle ni identifiant interne ni route.
4. Le scan ne déclenche jamais l’écriture métier. Il rend la route canonique et exige une confirmation en ligne dans le module propriétaire. Les règles de réception, mouvement, consommation, lancement, contrôle, outil et expédition restent donc dans leurs services existants.
5. `event_id` rend chaque lecture idempotente. Un rejeu strict rend le résultat enregistré ; le même UUID avec un autre code, acteur, flux, source ou horodatage est refusé. Les commandes de création, impression, invalidation et remplacement utilisent une `Idempotency-Key` UUID et un reçu persistant.
6. Le payload brut n’est jamais journalisé. L’audit de scan conserve son SHA-256, le verdict, l’acteur, le terminal, l’horodatage client, la réception serveur, le request ID et la corrélation. Les événements de scan, impression, commande et audit sont append-only.
7. La file générale hors ligne ne contient que des intentions de lecture chiffrées AES-256-GCM dans IndexedDB avec une clé non exportable, séparée par acteur et limitée à 250 événements. Elle conserve ordre, horodatage, tentatives et conflit. Elle ne remplace pas la file d’exécution atelier existante.
8. QR est le profil général caméra/lecteur 2D ; Code 128 cible la douchette clavier ou laser et les longues étiquettes ; Data Matrix cible les petites étiquettes durables avec imageur 2D. Les trois portent exactement le même contenu versionné.
9. La caméra repose sur `BarcodeDetector` lorsqu’il est réellement disponible. La douchette clavier avec Entrée et la saisie manuelle restent toujours possibles.
10. Le modèle de données actuel n’établit pas de frontière société/site universelle pour les neuf entités. Aucun `site_code` fourni par le navigateur n’est donc accepté. La frontière actuelle est rôle + accès au module ; une future isolation multi-société devra ajouter un rattachement serveur vérifiable avant d’alimenter cette colonne réservée.

## Alternatives écartées

- Encoder l’identifiant métier : couplage durable au schéma et fuite par lecture physique.
- Encoder un JWT ou une URL signée : secret rejouable imprimé et rotation difficile.
- Exécuter directement un mouvement lors du scan : duplication des validations, conflit hors ligne et risque d’écriture dans le mauvais flux.
- Stocker la file en clair dans `localStorage` : exposition des lectures à tout script de l’origine.
- Accepter un site transmis par le client : isolation déclarative non prouvée.

## Conséquences et rollback

La migration est additive. Avant toute preuve, le rollback SQL peut retirer les objets. Après émission, impression ou scan, les tables sont conservées ; on désactive les routes, redéploie la release précédente et invalide les étiquettes si nécessaire. Une restauration de base n’est utilisée qu’en incident coordonné avec la GED et les autres écritures métier.
