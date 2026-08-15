# Runbook — étiquettes, lecteurs et imprimantes SOL-30

- Propriétaire : Keenan Martin
- Version : 1, 2026-08-14
- Gravité : P1 si un poste est bloqué, P0 si toute identification est indisponible

## Symptômes et vérifications sûres

1. Vérifier `/health/ready`, puis `GET /api/v1/traceability/identification/capabilities` avec un compte de test autorisé.
2. Scanner le texte humainement lisible au clavier. Un refus `UNKNOWN`, `INVALIDATED`, `WRONG_ENTITY_TYPE`, `FORBIDDEN_STATUS` ou `INSUFFICIENT_PERMISSION` est un verdict métier, pas une panne du lecteur.
3. Contrôler que la douchette émet le code complet puis Entrée, sans préfixe propriétaire. Tester le champ par saisie manuelle.
4. Pour la caméra, vérifier HTTPS/loopback, la permission du navigateur et la présence de `BarcodeDetector`. Si absent, utiliser la douchette ou la saisie manuelle ; ne pas installer une extension non approuvée.
5. Vérifier la file locale : acteur, heure, tentatives et dernier verdict. `SYNCING` ne doit pas persister après un échec ; l’entrée redevient `REJECTED` et peut être rejouée.

## Choix du support

| Usage | Profil | Symbologie | Matériel et distance |
|---|---|---|---|
| bac, palette, dossier atelier | 50 × 30 mm papier ou synthétique | QR, module ≥ 0,5 mm | caméra ou imageur 2D, environ 20–50 cm |
| douchette clavier/laser existante | 50 × 30 mm | Code 128, dimension X ≥ 0,33 mm | laser/CCD ou imageur ; aligner le code face au lecteur |
| outil ou petite pièce | 30 × 15 mm polyester/résine durable | Data Matrix, module ≥ 0,4 mm | imageur 2D obligatoire, lecture courte |
| secours bureautique | feuille A4 | QR ou Code 128 | imprimante bureautique, découpe sans rogner la zone calme |

Utiliser 203 dpi pour les profils standard et préférer 300 dpi pour 30 × 15 mm. Ne jamais réduire le SVG par mise à l’échelle navigateur. Le code humain doit rester visible.

## Calibration et mise en service

1. Charger le bon support et le bon ruban ; nettoyer la tête.
2. Calibrer largeur, hauteur et détection d’intervalle dans le pilote constructeur.
3. Régler d’abord vitesse faible et contraste moyen ; augmenter seulement après essai.
4. Imprimer une étiquette de test depuis CERP, puis la relire avec le matériel réel à la distance d’usage.
5. Vérifier que le code humain, le type et `CERP v1` sont lisibles. Consigner le modèle, le DPI, le support et le résultat dans le suivi matériel.

## Réimpression, remplacement et invalidation

- Réimpression : saisir le motif, utiliser `Imprimer`; l’événement `REPRINT` est append-only.
- Étiquette détériorée ou perdue : utiliser `Remplacer`, imprimer la nouvelle étiquette, retirer/détruire l’ancienne et rescanner la nouvelle. L’ancienne devient immédiatement `REPLACED`.
- Mauvaise association : utiliser `Invalider`, isoler l’objet, corriger l’entité puis émettre une nouvelle étiquette. Ne jamais coller une étiquette d’un autre objet.
- Un scan d’ancienne étiquette doit rendre `INVALIDATED`; ne pas contourner ce verdict.

## Arbre de décision

- API indisponible : conserver les scans dans la file chiffrée ; aucune action métier n’est validée hors ligne.
- Imprimante indisponible : utiliser A4 ou une imprimante approuvée ; ne pas recopier un UUID à partir des logs.
- Code illisible : saisir le texte `CERP:1:…`; si accepté, remplacer l’étiquette.
- Code inconnu : isoler l’objet, rechercher l’étiquette dans CERP et ne pas créer un doublon.
- Permission refusée : demander le rôle/module requis ; ne pas emprunter une session administrateur.
- Statut interdit : traiter le blocage dans le module propriétaire, puis rescanner.

## Retour au service, communication et post-mortem

Le service est rétabli lorsque lecture clavier et au moins un matériel du poste rendent le bon objet, qu’un ancien code est refusé, que la file hors ligne se synchronise sans écriture métier automatique et qu’une impression se relit. Pour un P0, communiquer modules touchés, début, contournement sûr et heure de rétablissement. Conserver request/correlation IDs, modèles matériels, verdicts et chronologie ; ne joindre ni code brut, ni document, ni jeton.

Actions interdites : modifier les tables d’identification à la main, supprimer les événements, réactiver une ancienne étiquette, désactiver le RBAC, transformer un refus en succès ou augmenter arbitrairement une durée de retry.
