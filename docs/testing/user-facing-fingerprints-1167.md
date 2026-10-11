# Présentation des empreintes techniques — #1167

Demande : retirer les empreintes SHA des écrans métier et des PDF. Project Office : WP285, recette ERP globale.

Les écrans conservent les références, versions, indices, dates et états des dossiers. Les comparaisons de décisions Qualité, le contrôle des octets PDF, l'archivage GED, l'audit et les gardes de fraîcheur continuent d'utiliser leurs empreintes internes. Aucun changement de contrat API ni migration.

Les PDF déjà archivés restent identiques. La présentation simplifiée s'applique aux futures éditions ; un ancien document se réédite par le parcours normal si nécessaire. Les lacunes de provenance restent signalées dans le dossier as-built.

Vérification : TypeScript frontend/backend, lint des fichiers UI concernés, tests existants d'intégrité PDF, archivage, décisions Qualité et CGV, build web. Le rejeu Test clair/sombre et le déploiement restent à consigner dans le rapport de recette ; ce lot ne clôt pas la recette ERP globale.
