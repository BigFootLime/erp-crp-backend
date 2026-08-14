# Portail client SOL-29 — contrat d’exposition

Toutes les routes sont sous `/api/v1`. Les routes `/portal/auth/*` sont publiques et limitées en débit. Les autres routes `/portal/*` exigent le JWT portail ; elles n’acceptent ni jeton ERP ni `client_id` fourni par le navigateur. Les routes `/admin/client-portal/*` exigent un JWT ERP actif et `is_superadmin` dans la base courante.

## Champs exposés

| Entité | Champs publics | Exclus explicitement |
|---|---|---|
| Profil | `account_id`, `client_id`, `display_name`, `company_name`, `last_login_at` | email interne, rôles, notes, conditions commerciales |
| Commande | `id`, `numero`, `date_commande`, `statut`, `total_ht`, `total_ttc`, `currency`, `updated_at` | brouillons, marges, coûts, notes, historique interne |
| Livraison | `id`, `numero`, `statut`, `commande_id`, `commande_numero`, `date_creation`, `date_expedition`, `date_livraison`, `transporteur`, `tracking_number`, `updated_at` | brouillons, coûts transport, commentaires internes |
| Facture | `id`, `numero`, `commande_id`, `date_emission`, `date_echeance`, `statut`, `document_status`, `settlement_status`, `total_ht`, `total_ttc`, `currency`, `updated_at` | brouillons, écritures comptables, comptes, lettrage interne |
| Document publié | publication/version/document IDs, code, titre public, version, nom original, MIME, taille, SHA-256, état public, expiration, accusé, date de publication et métadonnées antivirus | chemin de stockage, contenu avant verdict, versions non publiées, journal GED interne |

Chaque liste retourne `source`, `freshness_at` et `reliability=SYSTEM_OF_RECORD`. Les montants ou devises absents restent `null`; ils ne sont jamais remplacés par zéro.

## Parcours

- `POST /admin/client-portal/accounts` puis `POST /admin/client-portal/accounts/{id}/invitations` : création inactive et invitation idempotentes.
- `POST /portal/auth/activate` : activation du jeton à usage unique et définition du mot de passe.
- `POST /portal/auth/login`, `POST /portal/auth/forgot-password`, `POST /portal/auth/reset-password` : session, récupération générique et révocation des anciennes sessions.
- `GET /portal/me|orders|deliveries|invoices|documents` : lecture isolée par le client du jeton.
- `GET /portal/documents/{publicationId}/download` : flux binaire uniquement si l’état calculé est `AVAILABLE`; en-têtes `Content-Disposition` et `X-CERP-Document-SHA256`.
- `POST /portal/documents/{publicationId}/acknowledgements` : accusé append-only et idempotent.
- `PATCH /admin/client-portal/accounts/{id}/status` : suspension, réactivation ou révocation motivée.
- `POST /admin/client-portal/publications` puis `POST /admin/client-portal/publications/{id}/revoke` : publication et retrait motivé.

Les commandes administratives de création, invitation et publication exigent `Idempotency-Key`. Les erreurs d’isolation retournent 400/401/403/404 sans donnée du client visé.
