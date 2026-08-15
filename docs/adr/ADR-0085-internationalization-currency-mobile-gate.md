# ADR-0085 — Gate internationalisation, devises et mobile

- Statut : accepté ; extension non activée
- Date : 2026-08-15
- Décideur produit : Keenan Martin
- Périmètre : locales, change et parcours mobiles

## Contexte

SOL-40 exige un besoin commercial confirmé. CERP+ sert actuellement un pilote
français : les 191 clients de `cerp_prod` portent `langue=fr` et `devise=EUR`. Aucune
commande, facture ou commande fournisseur ne permet de prouver un usage d'une autre
devise. Le référentiel connaît CHF, EUR, GBP et USD, mais il n'existe aucune table de
taux de change datés ; cette liste ne constitue donc pas une capacité de conversion.

Le frontend est francophone et utilise de nombreux formats `fr-FR`. Il n'a ni moteur
i18n ni PWA/service worker. Des parcours web ciblés sont déjà optimisés tablette ou
mobile : atelier, scan QR/code-barres, réception et stock. La file hors ligne atelier
est bornée, chiffrée et rapprochée côté serveur ; elle n'est pas une base locale.

## Décision immédiate

Aucune extraction massive de textes, traduction, table de change, PWA ou application
native n'est ajoutée sans marché cible. Le français, `Europe/Paris` et l'EUR restent
les valeurs produit actuelles, explicitement limitées. Les champs de devise existants
n'autorisent aucun total inter-devises et aucun écran ne doit convertir implicitement.

## Gate commercial

L'extension exige avant développement :

1. pays, langue, utilisateurs et parcours contractuels identifiés ;
2. exigences légales des documents, taxes, numérotations et archivage ;
3. devises nécessaires, fournisseur de taux, type de taux, fréquence et règle
   d'arrondi validés par Finance ;
4. appareils, OS, scanners, connectivité, durée hors ligne et politique MDM réels ;
5. valeur mesurable et support financé pour trois à cinq parcours maximum.

## Architecture conditionnelle

### Textes, formats et documents

- Les messages adoptent des clés stables et des catalogues versionnés. Le fallback
  contrôlé est `fr`, avec journal d'une clé manquante ; la clé brute n'est jamais
  affichée.
- La locale de session vient d'une préférence serveur autorisée, avec fallback de
  l'instance. Le navigateur ne change pas les règles métier ni le fuseau contractuel.
- Nombres, dates, unités et pluriels utilisent une couche unique. Les données API
  restent canoniques : ISO 8601, codes ISO, décimaux sous forme non ambiguë.
- Chaque document généré fige langue, modèle, mentions et version ; changer la langue
  d'un utilisateur ne régénère jamais silencieusement un document émis.

### Devises

- Un montant conserve valeur décimale et devise d'origine. Une conversion ajoute
  montant cible, taux décimal, paire, source, date/heure, type et empreinte de la
  version utilisée.
- Le taux est figé au moment de la décision comptable. L'historique n'est jamais
  recalculé avec le taux courant.
- En l'absence de taux applicable, le calcul et le total inter-devises sont
  indisponibles ; aucun taux 1 ou zéro n'est injecté.

### Mobile

Les parcours candidats restent : scan/identification, réception, atelier, inventaire
stock et approbation. La PWA est préférée seulement si le matériel réel fonctionne
avec les API web et la politique hors ligne ; une application native n'est retenue
que pour une contrainte prouvée (scanner/MDM/périphérique). Dans les deux cas, les API,
RBAC, idempotences et audits existants sont réutilisés.

Les secrets ne sont pas persistés côté client. Les intentions hors ligne sont
minimales, chiffrées, expirables et visibles ; le serveur décide du résultat et des
conflits. Aucun cache générique ne rend les données ERP consultables après révocation.

## Compatibilité et rollback

Cette décision ne change ni runtime ni schéma. Les parcours responsive et Electron
restent inchangés. Une future activation sera feature-flaggée par locale/parcours et
réversible vers `fr`/web ; les montants originaux et preuves de taux resteront
conservés lors d'un rollback.

## Conséquences

CERP+ n'engage pas une traduction coûteuse ni un second frontend sans client. Le
produit dispose cependant d'une frontière claire pour internationaliser sans fausser
les montants ou dupliquer les règles métier.
