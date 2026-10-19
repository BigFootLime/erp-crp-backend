# Retrait des comptes hérités

Le retrait conserve la ligne `public.users` et les preuves qui s'y réfèrent. Il
ne supprime ni les événements métier, ni le journal d'audit, ni les journaux de
connexion.

L'opérateur qualifié écrit uniquement le marqueur suivant dans
`users.directory_profile_metadata`, pour des comptes sans
`directory_profile_id` :

```json
{
  "cerp_account_retirement": {
    "schema_version": 1,
    "retired_at": "<ISO-8601>",
    "operation_id": "<UUID>"
  }
}
```

Le compte est aussi `Inactive` et son secret devient un hachage bcrypt
inconnu. Les identifiants locaux libérés sont remplacés par des valeurs uniques
de retrait. L'opération ne doit jamais viser le propriétaire actif.

Seul ce marqueur versionné masque le compte dans les listes locales
d'administration et de contrôle d'accès. Les entrées d'audit et historiques
restent consultables. Les lectures de comptes d'administration et les mutations
couvertes (édition/statut, invitation, récupération, reset et avatar) traitent
la cible comme introuvable ; les listes et cibles d'habilitation l'excluent.
Cela ne retire pas les références de cette identité dans les historiques.

Avant l'opération, l'opérateur vérifie la sauvegarde restaurable, la liste
exacte des comptes, l'absence de `directory_profile_id` pour chaque cible et
la présence d'un unique SuperAdmin actif. Après l'opération, il vérifie que les
listes opérationnelles ne montrent plus les comptes retirés et qu'une nouvelle
demande peut utiliser les identifiants libérés.

## Qualification du 19 octobre 2026

Les 45 tests ciblés et TypeScript passent. Le prédicat réel a aussi été exécuté
sur PostgreSQL 18 isolé, avec socket Unix privé et sans écoute réseau : seule
la version JSON numérique `1` retire une ligne, les métadonnées absentes, la
chaîne `"1"` et les autres versions restent visibles. Les références de ligne
SQL utilisent un alias simple, notamment `users` pour une table non aliasée.

L'opérateur privé a été répété sur un schéma synthétique : 17 comptes retirés,
un seul compte opérationnel, propriétaire/MFA/epoch identiques, historiques
conservés et droits retirés. Une cible contenant le propriétaire ou une
empreinte modifiée est rejetée avec annulation. Cette répétition ne vaut pas
restauration complète de la production ni qualification du déploiement.

L'application réelle reste conditionnée à la qualification et au déploiement
du backend au SHA exact attendu, une sauvegarde complète vérifiée de moins
d'une heure, un inventaire frais et une transaction avec vérifications finales.
Aucun changement du propriétaire, de ses clés, de son MFA ou de l'annuaire
commun n'est autorisé par ce nettoyage.
