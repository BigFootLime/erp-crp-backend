# Contrat public de contexte entreprise v1

Propriétaire : `erp-crp-backend`, issue #1521. Consommateur généré :
`crp-systems-web`, issue #1876. Ce lot reste non publié.

`src/module/entreprises/contract/company-context-contract-v1.ts` est l'unique
artefact versionné du contrat public de `GET /api/v1/entreprises/context`.
Les fixtures sont comparées aux réponses réellement construites par le service
et la chaîne route/middleware, sans ajouter de validation au retour du runtime.
Cet artefact ne représente pas le `CompanyContext` interne : `central_account_id` et
`directory_profile_id` ne sortent jamais de l'API.

La version reste `contract_version: 1`. Les en-têtes sont
`X-CERP-Company` et `X-CERP-Database` (la comparaison HTTP reste
insensible à la casse). Le lien de connexion est un indice de routage public :
il ne crée aucun droit et le runtime fixe, la session et l'annuaire restent
autoritaires.
La description OpenAPI de ces en-têtes utilise les mêmes constantes ; les
caractères obligatoire/facultatif de découverte et d'échange restent inchangés.

Les fixtures couvrent les réponses LEGACY, COMMERCIAL et INDUSTRIAL. Les tests
du consommateur frontend refusent une version inconnue, une entreprise active
absente de la liste, les UUID malformés et les identifiants dupliqués. Le producteur
conserve son comportement antérieur pour les listes Directory dupliquées ; ce
lot ne transforme pas cette différence de politique en une nouvelle erreur 503.
Le middleware conserve ses refus
pour contexte manquant, environnement divergent et référence inter-entreprise.

Toute évolution incompatible exige une nouvelle version de contrat et un couple
frontend/backend explicitement qualifié ; ne pas élargir les bornes frontend ou
backend pour les rendre artificiellement identiques.
