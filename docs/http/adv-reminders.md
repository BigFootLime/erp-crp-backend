# API Relances ADV — FEAT-CERP-0002

Surface authentifiée : `/api/v1/adv-reminders`. Les lectures exposent readiness, politique, suggestions, historique et préférence client. Les commandes permettent génération, approbation, envoi sandbox, reprise, annulation et opposition ; elles exigent une capacité Finance exacte et une clé d'idempotence.

Le job est désactivé par défaut, borné et limité au fournisseur `sandbox`. Il ne traite que des suggestions déjà approuvées par un humain. Les paiements et avoirs annulent transactionnellement les suggestions devenues obsolètes. Les événements, tentatives et reçus sont append-only.

Migration : `db/patches/20260805_adv_reminders.sql`, accompagnée de preflight, verify et rollback dev/test protégé dans `db/patches/support`.
