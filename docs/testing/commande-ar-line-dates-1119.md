# Délais par ligne sur le PDF AR (#1119)

Les nouveaux AR figent le délai civil de chaque ligne dans leur source officielle et le rendent sous la désignation, dans le tableau CERP existant. Un délai nul reste « à confirmer ». Le worker consomme exclusivement la source archivée, sans recharger la commande. Les sources historiques qui ne portent pas le champ conservent leur rendu ; les PDFs archivés ne sont jamais réécrits. Zéro migration, aucune modification du routage email.

Validation : PDF réellement rendu et décodé, deux échéances distinctes dont des limites de changement d’heure, date absente, source figée intacte, génération publique/fingerprint interne et autorisation/envoi idempotent existants. Épreuve visuelle du PDF puis nouveau document Base Test requis. Ne pas renvoyer les AR21/22 déjà envoyés. Destinataire recette autorisé unique : kesmartin2004@croix-rousse-precision.fr.

Épreuve visuelle complémentaire #1121 : le libellé long du bandeau CERP est mesuré avant de placer les valeurs. Vérifier les boîtes de texte du PDF réellement rendu et inspecter la page ; les libellés sur une ligne gardent leur espacement.
