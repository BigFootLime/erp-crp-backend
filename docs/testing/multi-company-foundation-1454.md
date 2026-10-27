# Multi-entreprises — qualification du premier lot local

> Historique du lot de contrats purs. Le socle désormais câblé est décrit dans
> [la qualification du runtime](multi-company-runtime-1454.md). Les limites et
> nombres ci-dessous concernent uniquement la première étape.

Date : 2026-10-26. Issues : backend #1454, frontend #1775.

## Périmètre réellement disponible

Les fichiers `src/module/entreprises/domain/` sont des contrats et fonctions
purs, sans accès PostgreSQL, HTTP, e-mail ou système de fichiers. Ils ne sont
pas montés dans l'application. Ils ne créent aucune entreprise ni aucun compte.
Le programme complet reste à intégrer et à qualifier en recette avant livraison.

- `company-context` : entreprise explicitement choisie, correspondance au runtime
  fixe, compte/profil annuaire, adhésion active, politique de modules et profil
  commercial accueil. Les ACL d'entrée sont des décisions serveur déjà résolues.
- `web-order-intake` : client professionnel ou particulier, connecteur boutique
  enregistré côté serveur, confirmation internet déclenchant une intention
  d'achat automatique. Brouillons, annulations, répétitions, changements et
  révisions en retard ont des résultats explicites.
- `intercompany-order` : achat source et commande client fournisseur distincts,
  variante/version figées, validation du fournisseur, annulation et suivi
  cumulatif d'expédition sans calcul décimal flottant.
- `intercompany-company-policy` : liaison entre contexte d'entreprise et
  commandes ; contrôle environnement, acheteur/fournisseur et module, puis
  injection de l'acteur serveur. Le client ne peut pas choisir son acteur.

L'identité client d'une boutique est distincte de l'identité d'un salarié CERP.
Le prix de vente au client final reste dans le dossier EC ; l'intention reçue
par le fournisseur ne l'inclut pas. Les montants ne sont ni convertis ni facturés
par ces contrats. Les prix achat et vente peuvent être identiques.

## Préconditions des futurs adaptateurs

1. Revalider compte, MFA, session et adhésion dans l'annuaire ; charger les ACL
   et l'entreprise depuis le serveur. Un JSON valide n'est pas une autorisation.
2. Vérifier signature, horodatage et portée du message boutique avant intake.
   Un connecteur de test ne peut pas produire un échange de production.
3. Résoudre chaque référence catalogue et version technique dans l'entreprise
   fournisseur autorisée ; ne pas accepter un UUID arbitraire fourni par la boutique.
4. Persister source, reçu d'idempotence et outbox dans une même transaction locale.
   Consommer avec inbox unique et verrou/contrôle de version. Les fonctions pures
   n'assurent aucune transaction distribuée ou exécution exactement une fois.
5. Traiter une modification comme un avenant et une annulation après acceptation
   comme une demande, sans défaire une réservation, un OF ou une expédition.
6. Confirmer les sorties uniquement à partir des expéditions réellement validées
   chez CRP. EC n'a aucun ledger de stock. CRP facture EC ; EC facture son client,
   avec leurs propres prix et numérotations, via les modules Finance existants.
7. Configurer les destinataires de notification par identifiant de profil
   annuaire. Les noms demandés par l'utilisateur ne sont pas des règles d'accès.

## Vérifications locales

Les dépendances du backend ont été installées avec le lock de ce worktree
(`pnpm install --frozen-lockfile`), sans changer package.json ou le lock.
Le node_modules d'un ancien checkout exposait Zod 4 tandis que ce lock impose
Zod 3 ; les validations finales utilisent le répertoire isolé corrigé.

Commandes depuis le worktree backend :

```powershell
npm run test:run -- src/module/entreprises src/shared-directory src/__tests__/auth-active-account.middleware.test.ts src/__tests__/access-control.gate.test.ts --maxWorkers=3
npm run build
node scripts/verify-vitest-collection.mjs
git diff --check
```

Le build vérifie TypeScript, l'inventaire et le contrat OpenAPI ainsi que
l'absence d'import runtime de données de test. Le contrôle de collecte garantit
que les tests appartiennent à ce checkout. Le dossier frontend ne contient que
des documents : vérifications documentaire et secrets exécutées localement.

Résultats : 139 tests réussis dans 16 fichiers (46 nouveaux scénarios de
contrats entreprise et 93 scénarios existants Directory/authentification/ACL).
Collecte contrôlée : 879 fichiers, empreinte
`272df34a03f1c9c02048e1c070e60d26f530060c6a33a64477158dd207a78145`.
Build et contrat OpenAPI valides : 1 600 opérations inventoriées. Les contrôles
de documentation, secrets et espaces du diff sont également passés.

## Limites et prochaine qualification

Aucun test à deux bases, test de restauration, test de provisioning, parcours
UI ou test de bout en bout n'est revendiqué. Il manque les tables et migrations
entreprise, l'extension signée de Directory, les routes, les transactions de
bridge, les notifications, l'accueil EC, les projections de stock/livraison et
les éditions EC. La future boutique est un chantier suivant.

Les accès aux deux entreprises demandés concernent Ghislaine, Thomas, Clément,
Nizier, Lambert, Jean-Marie et KEENAN ; leur affectation réelle nécessite leurs
profils annuaire exacts et n'est pas effectuée par ce lot.

Le suivi Project Office proposé est `CERP-MULTICOMPANY-EC`. Aucune session API
Project Office n'était disponible dans cet environnement ; aucune écriture
Project Office n'est revendiquée. Les issues et ce dossier conservent les preuves
locales à synchroniser. Aucun accès ni changement de production, push,
publication d'installateur ou modification du partage Z: n'a été réalisé.
