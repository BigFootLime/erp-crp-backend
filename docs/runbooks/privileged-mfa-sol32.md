# Runbook — MFA des comptes privilégiés SOL-32

- Propriétaire : Keenan Martin
- Version : 1, 2026-08-15
- Gravité : P0 si aucun administrateur ne peut s’authentifier ; P1 pour un seul compte

## Préparation et déploiement

1. Conserver les SHA frontend/backend précédents et passer par la procédure
   `docs/runbooks/database-upgrade-sol06.md` : sauvegarde complète, checksum,
   `pg_restore --list`, preflight et fenêtre de migration.
2. Injecter dans le gestionnaire de secrets de chaque cible :
   `MFA_ROOT_KEY` (32 octets encodés en 64 caractères hexadécimaux ou base64)
   et `MFA_KEY_ID=production-v1`. Ne jamais afficher la valeur dans le terminal,
   un ticket, Git ou le journal Coolify.
3. Les instances connectées à une même base doivent recevoir exactement la même
   clé. Les bases test et production séparées doivent utiliser des clés distinctes.
4. Vérifier la sauvegarde, puis exécuter avec `ON_ERROR_STOP=1` :

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/patches/support/20260815_privileged_mfa_sol32.preflight.sql
corepack pnpm db:patches:up
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/patches/support/20260815_privileged_mfa_sol32.verify.sql
corepack pnpm db:migrations:integrity
```

5. Déployer le backend, vérifier `/health/live` et `/health/ready`, puis le
   frontend. Un backend de production sans clé doit échouer au démarrage.
6. Faire enrôler un second superadministrateur avant toute opération risquée.
   Vérifier connexion, step-up et conservation hors ligne des codes de secours.

## Symptômes et vérifications sûres

- `MFA_REQUIRED` : l’ancienne session ou le facteur n’est plus valable ; refaire
  une connexion complète.
- `MFA_STEP_UP_REQUIRED` : la preuve a plus de cinq minutes ; saisir un nouveau
  TOTP dans la boîte de confirmation.
- `MFA_LOCKED` : cinq échecs ; attendre quinze minutes et vérifier l’heure du
  poste. Ne pas modifier `locked_until` en SQL.
- `MFA_CHALLENGE_EXPIRED` : recommencer la connexion ; ne pas prolonger le
  challenge.
- erreur de déchiffrement ou `Unsupported MFA key id` : arrêter la promotion,
  vérifier uniquement l’identifiant de clé et la cible du secret. Ne pas créer
  de nouvelle clé au hasard.

Pour diagnostiquer sans secret : corréler `request_id`, consulter les actions
`AUTH_MFA_*` dans l’audit et compter facteurs actifs/codes disponibles. Ne jamais
sélectionner `encrypted_secret`, ni joindre une capture du QR code.

## Remplacement, codes et révocation normale

Dans Administration → Sécurité MFA :

1. confirmer mot de passe et TOTP/code de secours courant ;
2. choisir le remplacement du facteur ou la régénération des codes ;
3. pour un remplacement, scanner le nouveau QR et le valider avant de retirer
   l’ancien appareil ;
4. sauvegarder les nouveaux codes, qui ne sont montrés qu’une fois ;
5. vérifier que l’ancienne session ou l’ancien facteur est refusé.

La révocation du dernier facteur privilégié est bloquée. Ne pas contourner le
RBAC ou modifier directement `user_mfa_factors`.

## Récupération hors bande d’un administrateur verrouillé

Préconditions : console sécurisée sur le backend exact déployé, URL DB injectée
par le gestionnaire de secrets, sauvegarde vérifiée, deuxième personne informée
et motif de 12 à 500 caractères.

Lecture seule obligatoire en premier :

```bash
corepack pnpm auth:mfa:recover -- --username=KEENAN
```

La sortie donne l’acquittement daté attendu. Après validation humaine, injecter
`MFA_RECOVERY_APPROVAL=SOL32:KEENAN:AAAA-MM-JJ` et
`MFA_RECOVERY_REASON=<motif du ticket>`, puis :

```bash
corepack pnpm auth:mfa:recover -- --username=KEENAN --apply
```

Critères de succès : `applied:true`, anciennes sessions refusées, événement
`AUTH_MFA_OUT_OF_BAND_RECOVERY` présent, puis nouvel enrôlement imposé au login.
Retirer immédiatement les deux variables de récupération du processus.

## Arbre de décision et rollback

- clé absente avant déploiement : ne pas migrer ; provisionner le secret ;
- migration non appliquée : redéployer les SHA précédents ;
- tables créées, aucun facteur actif/révoqué : exécuter le rollback SQL seulement
  après sauvegarde et preflight, puis redéployer les SHA précédents ;
- un facteur a existé : conserver les tables et redéployer temporairement le
  backend précédent, ou restaurer la sauvegarde dans une base neuve selon le
  runbook SOL-06 ; le script de rollback refusera la perte de preuve ;
- clé perdue : restaurer la clé depuis son coffre séparé. Sans elle, révoquer les
  facteurs un par un via la procédure hors bande ; ne jamais réinitialiser les
  graines par SQL.

## Retour au service et post-mortem

Le service est rétabli lorsque deux administrateurs peuvent se connecter avec
MFA, qu’une mutation exige un step-up, qu’un code de secours est consommé une
seule fois, que `/health/ready` est vert et que les audits sont corrélables.
Pour un P0, communiquer début, périmètre, contournement sûr et heure de reprise ;
conserver SHA, request IDs, chronologie et identifiants d’audit, sans secret.
