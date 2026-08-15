# Runbook — Adaptateur SUPER PDP

- Version : 2026-08-16
- Propriétaire : Keenan Martin
- Gravité maximale : P0 si aucune facture légale ne peut être transmise avant échéance

## Symptômes et impact

- panneau Administration → Facturation électronique rouge ;
- `SUPER_PDP_CREDENTIALS_MISSING`, `SUPER_PDP_NETWORK_ERROR`, `SUPER_PDP_COMPANY_NOT_VERIFIED` ou accumulation de documents sans statut officiel ;
- impact : dépôts différés. Une facture déjà émise reste dans CERP+ ; ne pas la recréer ni changer son numéro.

## Configuration d'une installation dédiée

Dans le coffre du service backend, définir sans les imprimer :

```text
EINVOICE_PROVIDER=super-pdp
EINVOICE_ENVIRONMENT=sandbox
SUPER_PDP_OAUTH_MODE=client_credentials
SUPER_PDP_BASE_URL=https://api.superpdp.tech
SUPER_PDP_CLIENT_ID=<secret-manager>
SUPER_PDP_CLIENT_SECRET=<secret-manager>
SUPER_PDP_TIMEOUT_MS=15000
EINVOICE_RECONCILE_INTERVAL_MS=300000
```

Redémarrer le service. Dans Administration → Facturation électronique, utiliser « Tester la connexion ». L'activation SQL n'est permise qu'après authentification et `company_verification_status=verified`.

Pour la production, remplacer seulement `EINVOICE_ENVIRONMENT=production`, utiliser les identifiants de production et ajouter temporairement `SUPER_PDP_PRODUCTION_ACTIVATION_ENABLED=true` pendant l'activation qualifiée. Ne jamais réutiliser les identifiants sandbox.

## Vérifications sûres

Depuis une copie locale du release :

```powershell
pnpm build
pnpm einvoice:super-pdp:smoke
```

La commande ne lit ni n'affiche le secret ; elle affiche seulement le statut de session. Pour SQL :

```sql
SELECT provider_code, environment, enabled, supported_formats, qualified_at, qualified_by
FROM public.einvoice_provider_connections
ORDER BY environment;

SELECT provider_code, count(*) AS documents,
       count(*) FILTER (WHERE provider_document_id IS NULL) AS pending_submission,
       count(*) FILTER (WHERE external_status_code IS NULL) AS pending_official_status
FROM public.einvoice_documents
GROUP BY provider_code;
```

## Arbre de décision

1. Identifiants absents : les ajouter au coffre, redémarrer, retester. Ne jamais les coller dans SQL, un ticket ou un log.
2. Réseau/timeout : vérifier DNS, TLS et sortie HTTPS vers `api.superpdp.tech`; ne pas augmenter le timeout pour masquer la panne.
3. Entreprise `needs_review`/`failed` : conserver la connexion inactive et ouvrir un dossier SUPER PDP avec l'identifiant de requête non sensible.
4. Statut `SUPER_PDP_STATUS_PENDING` : laisser le polling reprendre. Ne pas redéposer manuellement.
5. `api:invalid`, `fr:501` ou rejet officiel : corriger les données sources ; ne pas transformer l'erreur en statut 200.
6. Suspicion de compromission : désactiver la connexion, révoquer le secret chez SUPER PDP, créer un nouveau secret dans le coffre puis auditer les dépôts.

## Actions interdites

- afficher ou exporter `SUPER_PDP_CLIENT_SECRET` ;
- activer `authorization_code` sur l'ERP partagé avant l'isolation par société ;
- éditer une facture `ISSUED`, réutiliser un numéro légal ou supprimer les preuves append-only ;
- écrire directement un statut DGFiP en SQL ;
- forcer un webhook non signé.

## Retour au service

Le diagnostic est vert, une conversion sandbox UBL/CII/Factur-X réussit, un dépôt de test conserve le même `provider_document_id` après retry, et le statut officiel est rapproché. Valider ensuite une facture pilote avec la comptabilité. Conserver les identifiants de requête, heures et SHA de release dans le compte rendu d'incident.
