# ADR-0974 — Montage issu de la gamme figée

Le poste de production web #1211 doit présenter la remise des sous-pièces uniquement sur la phase de montage de l'OF. Le numéro de phase, le libellé et le dossier technique vivant ne permettent pas cette décision.

La lecture `operation-readiness` ajoute `assemblyOperation`, égal au type `ASSEMBLAGE` de la phase dans `technical_snapshot.operations`. Le champ est additif. La requête utilise déjà cette source pour les droits de démarrage et le contrôle des composants ; aucune SQL ni migration n'est ajoutée. Sans type figé, il vaut faux. Le frontend exige exactement une phase de montage et l'identité de l'opération affichée avant de monter le panneau #1211. La commande reste validée par son propriétaire Stock et Production (#956/#959), même si l'état de lecture a vieilli.

Le routage web de `COMPONENTS_MISSING` vers Composants utilise déjà le code de l'alerte. L'enum historique `target` est conservé pour les clients distribués. Ce lot ne modifie aucun blocage, plafond, pointage, quantité bonne ou mouvement stock. Les routes natives #971 restent réservées au poste PIN natif ; les API ERP du responsable atelier utilisent son identité ERP.

Recette commune finale : montage unique reconnu ; tournage et phase sans type exclues ; deux phases de montage exclues du panneau ; même numéro avec un libellé ressemblant à un montage mais type tournage exclu ; changement de la PT vivante sans changement de snapshot sans effet ; retour réseau et version modifiée recontrôlés par la commande canonique. Scénarios préparés, non exécutés à ce stade suivant l'instruction humaine. Compilation TypeScript et OpenAPI avant intégration.
