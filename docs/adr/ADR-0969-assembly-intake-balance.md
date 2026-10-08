# ADR-0969 — Bilan physique de mise en montage

Date : 2026-10-08. Issue #969 ; suite de #956/#959 et interface web #1211.

L’aperçu de prélèvement calculait directement la prochaine sortie de composants.
Après prélèvement complet, le reliquat nul provoquait une erreur de quantité et
masquait le bilan utile à l’opérateur.

Le domaine expose désormais un bilan physique exact : quantité figée, déjà mise
en montage, reliquat et détail par OF source. Il applique les mêmes contrôles de
version, unité stock, nomenclature, précision et équilibre entre sous-pièces que
le plan de prélèvement. Les OF regroupés conservent leurs sources sans répartir
des fractions d’assemblage. Ce calcul ne lit aucune déclaration de pièce bonne,
rebut, reprise ou pointage.

L’aperçu ajoute `balance` (nullable si rapprochement requis). Une lecture sans
quantité demandée à reliquat zéro retourne `balance`, `plan: null` et
`canWithdraw: false`, sans fabriquer d’erreur de dépassement. Les autres
blocages de dossier, planning ou opération restent visibles. Une demande
explicite de quantité excessive est toujours rejetée. Aucune commande de stock,
réservation, règle de permission ou route d’écriture n’est modifiée.

Build TypeScript/OpenAPI requis. Cas de bilan complet, sources regroupées et
preuves contradictoires préparés pour la recette globale finale, non exécutés
à cet incrément conformément à la consigne utilisateur. Aucun SQL nouveau ni
migration. Le raccordement web et React Native reste un chantier distinct.
