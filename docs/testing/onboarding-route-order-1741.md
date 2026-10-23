# Onboarding : ordre de montage des routes

23 octobre 2026. Incident frontend #1741 : un compte disposant de `parametrage-erp`
reçoit 403 sur `/admin/onboarding/status` en ouvrant une page métier.

Le routeur onboarding de la version publiée exige déjà `requireErpConfiguration`.
Cependant `/admin` était monté avant `/admin/onboarding` et son middleware global
`requireSuperadmin` rejetait la requête avant le routeur spécialisé. Monter le
préfixe spécialisé avant le préfixe général préserve les autorisations nominatives,
le refus pour les comptes sans droit et le MFA récent pour les écritures.

Aucune migration, attribution de droit ou modification des comptes. Publication
demandée explicitement par Keenan avec les finitions d’affichage, sans nouvelle
campagne de tests. Les contrôles de construction, d’intégrité et de santé de
publication ne constituent pas une recette métier sur le compte de la salariée.
