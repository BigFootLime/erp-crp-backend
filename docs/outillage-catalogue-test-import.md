# Import catalogue outillage — cerp_test uniquement

Ce flux interne n’expose aucune route HTTP et ne lit aucun jeton utilisateur. Il crée un compte technique **inactif** et audité (`CERP_TEST_CATALOGUE_IMPORT`) uniquement si la provenance doit être écrite et si la base connectée est exactement `cerp_test`.

1. Appliquer une seule fois le patch test-only `db/test-only-patches/20261025_outillage_catalogue_source_specifications_test_only.sql` contre `cerp_test`. Il refuse tout autre nom de base et ne doit pas être ajouté au runner de patches production/template.
2. Compiler: `npm run build`.
3. Vérifier le dataset sans écriture: `npm run outillage:catalogue-import:test -- --dataset <chemin-absolu> --sha256 <sha256>`.
4. Après lecture du rapport, activer explicitement l’écriture test avec le répertoire privé contenant les assets hashés: `CERP_TOOL_CATALOGUE_TEST_IMPORT=true CERP_TOOL_CATALOGUE_IMPORT_MEDIA_ROOT=<dossier-assets> npm run outillage:catalogue-import:test -- --dataset <chemin-absolu> --sha256 <sha256> --apply`.

Le dataset contient `records[]`. Chaque record doit fournir fabricant, famille, référence, source (`document`, `sha256`, `page`, `rect` à quatre coordonnées) et `stock: { state: "pending_inventory", quantity: null }`. L’import génère la codification seulement si elle est absente, conserve les spécifications non mappées dans la provenance JSONB, crée stock ERP à zéro sans mouvement ni prix, et marque ainsi chaque fiche pour inventaire physique.

Les médias ne sont lus que sous `CERP_TOOL_CATALOGUE_IMPORT_MEDIA_ROOT`: leur nom simple, type, taille, absence de lien symbolique et SHA-256 déclaré dans chaque record sont vérifiés, puis ils passent la validation/scanner et le pipeline d’upload outillage existants. Le replay est sérialisé par verrou PostgreSQL sur fabricant/référence/ancre source et retrouve les créations déjà présentes. Toute ligne sans provenance géométrique complète est refusée par le dry-run au lieu d’inventer une zone source.
