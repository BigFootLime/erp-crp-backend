# Clôture de développement du flux métier — L7 / #835

Project Office : WP-272. Frontend : #1101. La qualification détaillée N01–N23 est conservée dans `crp-systems-web/docs/design/flux-audit-completion-1101.md`.

## Corrections

- `required_for_admins` exige le MFA des superadmins et des rôles canoniques Directeur, Gérant et Administrateur Systeme et Reseau, principaux ou secondaires. Le même prédicat gouverne le login, les requêtes déjà authentifiées, le statut MFA, la révocation et la revue des accès. Directeur Technique ne reçoit pas de privilège administratif. Aucune création de compte, modification de mot de passe, inscription ou révocation de facteur n'est effectuée par cette livraison.
- La suppression d'une commande initiale ne consulte plus les tables quick_commande supprimées par `20260306_drop_quick_commande.sql`. Les protections de rétention sur affaires, allocations, OF, réservations, commandes fournisseur, livraisons, AR et factures sont conservées.
- La péremption du lot bloque les nouvelles réservations, l'emploi d'une réservation antérieure et l'expédition. La date reste valable jusqu'à la fin du jour indiqué en Europe/Paris. Une libération qualité ne remet pas la péremption à zéro. L'évaluation et la décision opérationnelle utilisent la même règle. La facturation d'une expédition antérieure conserve la référence de sa date de départ et n'est pas rétroactivement bloquée au lendemain de péremption. Les dates saisies sont validées avant leur conversion SQL. Aucun lot n'est automatiquement rebuté ni modifié.
- Une homologation globale fournisseur explicitement configurée doit être `homologue` et dans sa période de validité à la soumission, l'approbation et l'envoi d'une commande fournisseur. Une décision sous réserve nécessite une résolution par la Qualité avant l'engagement. La décision/version/document consultés sont enregistrés dans l'audit de transition. Les mutations de qualification et d'achat prennent le même verrou fournisseur. L'absence de décision reste `NOT_CONFIGURED`, jamais « homologuée ». Les agréments par domaine/client et les réserves détaillées constituent un chantier complémentaire précisément identifié ; aucune correspondance arbitraire entre domaine et type de ligne n'est créée.

## Exploitation

Migration additive non nécessaire : les colonnes et tables exploitées existent dans le schéma après L6. Vérifier les requêtes contre ce schéma avant la bascule. Déployer les deux services HYPERBOX2 ainsi que le backend public et les interfaces depuis les artefacts des branches main.

Les sessions sans MFA d'un compte devenu soumis à l'obligation peuvent recevoir la réponse métier MFA requise ; une nouvelle connexion déclenche l'enrôlement normal. Les mécanismes existants de récupération et remplacement sont conservés.

## Recette regroupée, après les implémentations

1. Exécuter les tests métier L1–L7 et les contrôles requis des dépôts une fois, conserver leurs sorties et corriger les échecs pertinents.
2. Compiler les requêtes modifiées sur un schéma isolé ; vérifier la suppression d'une commande initiale dans Test, sans supprimer une commande réelle.
3. Exécuter les scénarios R01–R26 de l'audit dans `cerp_test`, avec fixtures identifiées et preuves API/interface/base/documents.
4. Vérifier MFA principal/secondaire, compte non administratif, péremption en été/hiver et à la date limite, réservation faite avant péremption, achat approuvé puis qualification expirée avant envoi.
5. Conserver séparément les preuves de déploiement et les résultats de recette. Aucun lot livré n'est déclaré recetté sur la seule base de son démarrage.
