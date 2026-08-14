# Runbook opérateur — facturation électronique et Plateforme Agréée

- Propriétaire : exploitation CERP+ / responsable finance
- Version : 1.0
- Dernière vérification : 2026-08-14
- Patch : `20260814_electronic_invoicing_sol26.sql`
- ADR : `docs/adr/ADR-0072-electronic-invoicing-provider-boundary.md`

## Symptômes, impact et gravité

| Symptôme | Impact | Gravité |
|---|---|---|
| `NO_QUALIFIED_PROVIDER` | aucun envoi ni réception électronique | P1 avant obligation, P0 pendant obligation |
| hausse de `EINVOICE_PROVIDER_ERROR` ou retries | dépôts retardés, résultat parfois incertain | P1, P0 si généralisé |
| statut 210/213 | facture refusée/rejetée, correction métier requise | P1 par document |
| webhook invalide/expiré | statut non rapproché automatiquement | P1 si répété |
| empreinte ou événement en conflit | preuve prestataire incohérente | P0 |

## Vérifications sûres

Ne jamais imprimer les variables secrètes. Vérifier l'identité, la version et la
base, puis exécuter uniquement les commandes de lecture :

```powershell
Invoke-RestMethod "$env:CERP_API_URL/health"
Invoke-RestMethod "$env:CERP_API_URL/api/v1/factures/electronic-invoicing/readiness" -Headers @{ Authorization = "Bearer $env:CERP_OPERATOR_TOKEN" }
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f db/patches/support/20260814_electronic_invoicing_sol26.verify.sql
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -c "SELECT provider_code,environment,enabled,supported_formats,qualified_at FROM public.einvoice_provider_connections ORDER BY environment"
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -c "SELECT provider_code,external_status_code,count(*) FROM public.einvoice_documents GROUP BY 1,2 ORDER BY 1,2"
```

Dans les logs structurés, filtrer `electronic_invoice_submission_failed`,
`electronic_invoice_worker_failed`, `correlation_id` et l'UUID du document. Ne pas
chercher par nom client, email, XML ou numéro bancaire.

## Déploiement et activation

1. Confirmer que la PA est officiellement agréée, que la qualification prévue dans
   ADR-0072 est signée et que les secrets existent séparément sur chaque cible.
2. Geler les émissions ; produire une sauvegarde chiffrée, mesurer taille et SHA-256,
   puis prouver sa restauration sur une base isolée.
3. Exécuter preflight, patch et verify :

   ```powershell
   psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f db/patches/support/20260814_electronic_invoicing_sol26.preflight.sql
   pnpm db:patches:up -- --only 20260814_electronic_invoicing_sol26.sql
   psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f db/patches/support/20260814_electronic_invoicing_sol26.verify.sql
   ```

4. Déployer le backend avec l'adaptateur qualifié, mais conserver la connexion
   désactivée. Vérifier `/health` et le readiness électronique.
5. Activer d'abord `sandbox`, exécuter les scénarios de qualification, puis répéter
   la procédure pour `production` dans une fenêtre approuvée. Une seule connexion
   peut être active par environnement.

## Arbre de décision incident

- Readiness indisponible : ne rien envoyer. Vérifier ligne active, environnement,
  `adapter_key` et présence du binaire ; corriger la configuration puis retester.
- `429`/5xx/timeout : laisser la file appliquer son backoff. Si la PA confirme un
  commit, rapprocher avant tout nouvel envoi. Ne jamais changer la clé d'idempotence.
- 210 ou 213 : ouvrir la facture et le motif officiel, corriger par le workflow légal
  approprié (souvent avoir/nouvelle facture), puis conserver le rejet original.
- Webhook invalide : vérifier dérive d'horloge, rotation du secret/certificat et IP
  documentées. Ne pas désactiver la signature ; utiliser le rapprochement authentifié.
- Conflit d'empreinte/événement : geler le connecteur, conserver requête/corrélation,
  contacter la PA et le responsable sécurité. Traiter comme P0.
- Scanner ou GED indisponible pour une réception : garder le fichier non consultable
  et l'état en attente ; ne jamais publier avant verdict documentaire.

## Retour au service

Le service est rétabli lorsque readiness est vert, qu'un document de preuve bac à
sable suit le cycle attendu, que le backlog décroît sans doublon, que les webhooks
sont signés et que les empreintes/preuves sont présentes. Le responsable finance
valide un échantillon de facture et d'avoir ainsi qu'une réception avant levée du gel.

## Rollback

- Incident applicatif : désactiver la connexion, laisser les lignes et preuves,
  redéployer le SHA précédent et rapprocher les résultats incertains avec la PA.
- Migration test sans preuve : exécuter le support de rollback uniquement sur la
  base explicitement isolée.
- Production ou preuve existante : ne jamais exécuter le rollback SQL. Restaurer la
  sauvegarde pré-migration dans une nouvelle base, vérifier comptages et empreintes,
  puis promouvoir cette base après validation finance.

```powershell
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f db/patches/support/20260814_electronic_invoicing_sol26.rollback.sql
```

## Actions interdites, communication et post-mortem

Interdiction de forcer un statut, supprimer une preuve, réutiliser une clé pour un
autre document, enregistrer un secret/XML/PDF dans les logs, contourner RBAC ou
activer une PA non qualifiée. Communiquer périmètre, documents touchés, dernier
statut certain, consigne utilisateur et prochaine mise à jour sans données client.
Le post-mortem conserve SHA déployé, fenêtre, corrélations, cause, chronologie,
preuve de non-duplication, action préventive, responsable et échéance.
