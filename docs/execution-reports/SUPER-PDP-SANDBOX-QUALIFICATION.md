# Qualification SUPER PDP en bac à sable

- Date : 2026-08-16
- Propriétaire : Keenan Martin
- Périmètre : adaptateur de facturation électronique CERP+ / SUPER PDP
- Commit backend qualifié : `55a5b7f0feaa74e520b765bc6a2d741d36f15646`
- Verdict global : **PARTIEL — transport qualifié, émission depuis une facture CERP bloquée honnêtement par des données métier manquantes**

## Résultat en langage opérateur

La connexion OAuth, la conversion des trois formats, le dépôt UBL, la lecture du cycle de vie et la reprise idempotente ont été exécutés contre le vrai bac à sable SUPER PDP. Le transport est qualifié. Une facture construite par CERP+ passe désormais la conversion UBL, CII et Factur-X, mais son dépôt complet ne doit pas être déclaré prêt tant que CERP+ ne capture pas le cadre de facturation obligatoire BT-23 et l'adresse électronique de routage distincte des identifiants légaux. Le suivi exact est l'issue `#599`.

## Frontières et sécurité

- Aucun secret, jeton OAuth ou contenu de facture n'est inscrit dans Git, ce rapport ou les sorties conservées.
- Les identifiants sont lus uniquement depuis le coffre d'environnement du service.
- Les documents déposés sont les sociétés et données fictives officielles du bac à sable SUPER PDP.
- Aucune écriture n'a été réalisée dans `cerp_prod`.
- La seule écriture SQL applicative est l'activation réversible de la connexion dans `cerp_test`, depuis le panneau administrateur.
- Le verrou de production SUPER PDP reste fermé ; aucune facture réelle n'a été émise.
- La clé de test divulguée dans une conversation doit être renouvelée avant toute qualification de production.

## Preuves exécutées

### Transport complet avec la facture de référence du prestataire

Exécution finale : `EINVOICE_SANDBOX_20260816004237`.

| Contrôle | Résultat mesuré |
| --- | --- |
| Environnement déclaré par l'adaptateur | `sandbox` |
| OAuth configuré / joignable / authentifié | `true / true / true` |
| Vérification de l'entreprise de test | `verified` |
| Conversion | UBL, 11 778 octets, empreinte SHA-256 calculée |
| Document prestataire | `333532` |
| Retry avec le même `external_id` | même document `333532`, aucun doublon |
| Dernier statut officiel observé | `fr:202` — reçue par la plateforme |
| Rejet | aucun |

Une exécution antérieure indépendante, `EINVOICE_SANDBOX_20260816000927`, avait déjà atteint les événements `api:uploaded`, `fr:200`, `fr:201` et `fr:202` sur le document prestataire `333530`.

### Conversion d'une source construite par CERP+

Sur l'image Coolify exacte `55a5b7f0feaa74e520b765bc6a2d741d36f15646` :

| Format | Taille | Signature contrôlée | Résultat |
| --- | ---: | --- | --- |
| UBL | 8 225 octets | XML `Invoice` | PASS |
| CII | 10 214 octets | `CrossIndustryInvoice` | PASS |
| Factur-X | 27 965 octets | en-tête `%PDF-` | PASS |

Les empreintes SHA-256 ont été calculées à l'exécution et ne sont pas utilisées comme données métier.

### Interface administrateur

Vérification navigateur sur l'API isolée `cerp_test` :

- environnement affiché : « Bac à sable » ;
- état SQL : « Activée » ;
- formats : `FACTUR_X`, `UBL`, `CII` ;
- cinq contrôles verts : adaptateur, identifiant, secret dans le coffre, session authentifiée, entreprise vérifiée ;
- action « Tester la connexion » : `UI_DIAGNOSTIC_PASS` ;
- le secret n'est ni lu ni affiché par l'interface.

## Défauts découverts et cause racine

| Issue | Cause racine | Correctif | Promotion |
| --- | --- | --- | --- |
| `#585` | la requête de workflow lisait `commande_ligne.updated_at`, colonne absente du schéma réel | version de prix fondée sur les valeurs canoniques prix/remise/TVA | PR `#587`, release `#588`, commit `9ac1458` |
| `#589` | extension optionnelle `line_with_vat_net_amount` non gérée par le convertisseur UBL SUPER PDP | extension supprimée ; totaux obligatoires conservés | PR `#591`, release `#592`, commit `8953642` |
| `#593` | `line_vat_amount` scalaire devenait un `TaxAmount` UBL sans `currencyID` | extension de TVA de ligne omise comme dans la fixture officielle ; ventilation TVA document conservée | PR `#594`, release `#595`, commit `ebe9139` |
| `#596` | CERP forçait `processing_rule=B2B`, alors que l'OpenAPI le déclare optionnel et rejette une valeur différente de celle calculée | la PA calcule et valide la règle ; les pre-checks restent activés | PR `#597`, release `#598`, commit `55a5b7f` |

Ces corrections ne masquent aucun contrôle : elles retirent uniquement des extensions optionnelles incompatibles et une supposition de routage. Les montants HT, TVA, TTC et la ventilation par taux restent présents.

## Tests reproductibles

Sur le dernier changement applicatif :

```text
npx vitest run src/module/facturation/electronic-invoicing
3 fichiers réussis, 14 tests réussis

npm run build
1072 opérations OpenAPI inventoriées, contrat valide
frontière des données de production validée sur 740 fichiers source et 740 fichiers émis

npm audit --omit=dev --audit-level=high
0 vulnérabilité de production
```

Les changements précédents ont chacun été testés avant promotion : tests ciblés de l'adaptateur/service, contrôle de requête SQL et build TypeScript. Aucun timeout, mock de prestataire ou désactivation de validation n'a servi à obtenir le verdict live.

Le healthcheck public après déploiement Coolify répond `ready` avec la version `55a5b7f0feaa74e520b765bc6a2d741d36f15646`; les contrôles DB, GED, antivirus et temps réel sont `up`. Il s'agit d'une lecture de santé, pas d'une écriture de production.

## Limite bloquante restante — issue #599

Le dépôt d'une source construite par CERP a atteint le contrôle réglementaire BT-23. Ce champ exprime le cadre de facturation : biens, services ou mixte, puis le scénario (facture normale, déjà payée, définitive après acompte, sous-traitance, etc.). Cette information n'existe pas dans les instantanés de facture actuels et ne peut pas être déduite honnêtement d'une désignation.

Le bac à sable utilise aussi des adresses électroniques `0225` distinctes du SIREN/SIRET légal. CERP utilise aujourd'hui le SIRET/SIREN pour les deux rôles. La qualification complète exige donc :

1. une sélection explicite et auditée du code BT-23 avant l'émission légale ;
2. des champs séparés `scheme` / `value` pour l'adresse électronique vendeur et acheteur ;
3. snapshot, migration avec preflight/verify/rollback, API, RBAC et interface fonctionnelle ;
4. un test E2E CERP facture émise → PA → statut officiel avec les sociétés de test SUPER PDP.

Jusqu'à livraison de `#599`, CERP doit échouer avec un message actionnable plutôt qu'inventer `B1`, `S1` ou `M1`.

## Déploiement, compatibilité et rollback

- Code applicatif et image Coolify qualifiés : `55a5b7f0feaa74e520b765bc6a2d741d36f15646`. La promotion ultérieure de ce rapport ne modifie aucun fichier runtime.
- Aucun patch SQL ou changement de données n'accompagne les quatre correctifs.
- Compatibilité : les factures existantes et les statuts persistés restent inchangés ; l'idempotence par `external_id` est conservée.
- Pour couper le connecteur : désactiver la connexion dans Administration, retirer `EINVOICE_PROVIDER=super-pdp` du coffre puis redémarrer le backend.
- Pour revenir au code antérieur : redéployer l'image immuable précédente puis réactiver uniquement après le diagnostic vert. Ne jamais supprimer les événements append-only déjà reçus.
- Les commits applicatifs réversibles sont `724f883`, `765c5ae`, `0e7d742` et `3534773`.

## Sources de contrat

- OpenAPI SUPER PDP : <https://api.superpdp.tech/openapi/superpdp.json>
- Documentation du bac à sable : <https://www.superpdp.tech/actualites/2025-11-20-bac-a-sable-api-documentation-disponibles/>
- Norme AFNOR publiée par l'administration, notamment BR-FR-08 / BT-23 : <https://www.impots.gouv.fr/factures-norme-afnor>
- Cadre officiel des plateformes agréées : <https://www.impots.gouv.fr/facturation-electronique-et-plateformes-agreees>
