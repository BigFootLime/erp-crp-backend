# Contrôles à plan figé : écritures historiques (#1137)

WP285 / FLUX-20261009-08, S01/S02/S09. Interface associée : web #1366, OBS076/OBS077.

Les routes historiques PATCH et validation verrouillent le contrôle avant toute lecture mutable. La présence d'un plan ou d'une empreinte renvoie HTTP 409 `QUALITY_CANONICAL_EXECUTION_REQUIRED` et demande d'ouvrir `/qualite/executions/:id`. Aucun remplacement de points, validation, audit de réussite ou notification n'est enregistré. Les seules données sans plan et sans empreinte gardent leur parcours historique.

Vérification : tests des deux mutations (plan complet, plan seul, empreinte seule, absent), refus sans écriture avec rollback, conservation des vrais contrôles historiques. Le test PostgreSQL est limité à la base jetable `quality_legacy_1137` ; il vérifie la projection de provenance et la durée du verrou, sans simuler une recette ERP complète.

Aucun changement de RBAC, de métrologie, de verdict ou de disposition Qualité 360 ; aucune migration. Le refus serveur protège aussi les anciens onglets et les clients d'API. La recette métier globale reste en cours et la validation métrologie distincte reste requise.
