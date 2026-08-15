# Rapport d'exécution — SOL-39

- Date : 2026-08-15
- Issue : https://github.com/BigFootLime/erp-crp-backend/issues/546
- Branche : `docs/546-sol39-forecast-data-gate`
- Base : `origin/main` `03570c5918edd8d0506413931ea3e8722c9ca89e`
- Verdict : **NO-GO prévision — historique inexistant**

## Diagnostic et cause racine

La précondition SOL-39 n'est pas partiellement faible : elle est absente. La base de
production n'a aucune transaction sur les sept séries nécessaires et aucun article.
Il est donc impossible de mesurer saisonnalité, biais, intermittence, référence
remplacée, surstock, rupture ou qualité hors échantillon.

Créer une moyenne ou un modèle sur des fixtures donnerait un résultat techniquement
testable mais commercialement faux. La projection SOL-19 reste autoritaire pour les
besoins fermes et explicitement paramétrés ; elle n'est pas une prévision de demande.

## Preuves mesurées

Transaction PostgreSQL `BEGIN READ ONLY` sur `cerp_prod` :

| Dataset | Lignes | Premier/dernier | Mois actifs |
|---|---:|---|---:|
| devis | 0 | indisponible | 0 |
| commandes clients | 0 | indisponible | 0 |
| commandes fournisseurs | 0 | indisponible | 0 |
| factures | 0 | indisponible | 0 |
| ordres de fabrication | 0 | indisponible | 0 |
| pointages | 0 | indisponible | 0 |
| mouvements de stock | 0 | indisponible | 0 |

Le même contrôle compte 0 article et 0 ligne de devis, vente, achat ou stock. Les
issues des deux dépôts ne contiennent aucune demande financée de prévision/MRP
statistique.

## Choix d'architecture

`ADR-0084` définit un gate par article/famille, au moins 52 semaines consécutives et
deux cycles avant saisonnalité annuelle, mais exige aussi continuité des références,
ruptures identifiées, unités, changements de régime et couverture mesurée. Il décrit
des baselines simples, un backtesting chronologique, les métriques et la séparation
stricte entre prévisions approuvées et besoins fermes MRP.

## Fichiers, migrations et données

- `docs/adr/ADR-0084-demand-forecast-data-readiness.md` ;
- `docs/execution-reports/SOL-39.md`.

Aucun modèle, endpoint, écran, migration, fixture de production ou donnée n'est
ajouté. Aucune proposition automatique n'est activée.

## Tests et vérifications

| Contrôle | Résultat |
|---|---|
| audit temporel `cerp_prod` read-only | PASS — 7 datasets à 0 ligne |
| audit lignes/articles | PASS — tous à 0 |
| tests ciblés projection/réapprovisionnement SOL-19 | PASS — 6 fichiers, 31 tests |
| validation UTF-8 des Markdown | PASS — 2/2 |
| `git diff --check` | PASS |

Le navigateur et un backtest sont non applicables : aucune prévision n'est exposée
et aucune fenêtre historique réelle ne peut être testée.

## Risques et compatibilité

- Une année seule peut rester non représentative ; les ruptures de régime doivent
  être examinées humainement.
- La demande observée pendant une rupture est censurée et ne doit pas être traitée
  comme zéro.
- Les séries de test synthétiques futures resteront hors du bundle et de la base de
  production.
- SOL-19 reste inchangé et compatible.

## Rollback

Revenir sur le commit documentaire retire l'ADR et le rapport. Aucun rollback SQL,
applicatif ou de données n'est requis.

## Reste réellement à faire

1. Utiliser CERP+ en production et accumuler des transactions propres et datées.
2. Produire périodiquement le rapport de readiness ADR-0084 par segment.
3. Une fois le gate franchi, implémenter les baselines et le backtesting avant toute
   méthode complexe.
4. N'autoriser la consommation MRP qu'après validation humaine et surveillance de
   dérive.
