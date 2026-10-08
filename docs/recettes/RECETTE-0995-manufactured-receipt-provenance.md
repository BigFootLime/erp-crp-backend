# Recette #995 — Réceptions fabriquées et provenance

**Préparée, NON EXÉCUTÉE.** Recette commune finale sur Base Test.

- Réception OF valide : racine Stock et preuve réception/OF/PT/version/lot/quantité
  figées dans le même commit, sans prix de vente ni prix fournisseur utilisé.
- Annulation de la transaction : aucune preuve ou réception partielle conservée.
- Deux réceptions concurrentes : les verrouillages OF existants restent appliqués ;
  capture indépendante de chaque racine et aucun doublon au rejeu idempotent.
- Mouvements d'achat, transferts, chutes et annulations : pas de provenance de
  fabrication attribuée à tort ; priorité conservée aux retours explicitement liés.
- Réception avant la frontière : aucune reconstruction, preuve manquante explicite.
- Mutation/suppression/troncature/insertion directe de preuve : refus ; lien de SHA
  et transaction toujours conforme, y compris après modification de la fiche lot.
- Marge absente/estimée/partielle : UNKNOWN, allocation de fabrication requise.
  Marge ACTUAL sauvegardée : référence conservée, toujours aucune activation ou
  affectation monétaire automatique dans ce lot.
- Lot, OF, version, unité ou quantité divergents : preuve inconnue explicite.
- Dossiers dépassant les bornes : diagnostic de densité, aucune complétude fictive ;
  mesurer le temps de commit pendant la recette finale.
- Quantité physique reçue et statut qualité inchangés si le coût est absent.
- Projet PREPARED et zéro entrée financière après migration ; verify structurel.
- Retour arrière SQL refusé après capture ; sauvegardes intégrales et preuves
  conservées. Préparer ensuite le partage exact des coûts et ses annulations.
