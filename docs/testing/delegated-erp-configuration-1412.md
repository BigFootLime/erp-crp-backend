# Paramétrage ERP délégué

Project Office : `ERP-DELEGATED-SETTINGS-20261022`. Issues backend #1412 et frontend #1734.

Le module fermé par défaut `parametrage-erp` porte les préfixes exacts
`/admin/onboarding`, `/admin/erp-settings` et `/admin/reference-data`, ainsi que
les pages `erp-settings` et `reference-data`. Son attribution par compte est
modifiable dans Utilisateurs et modules ; un intitulé « Directeur » ou
« administrateur métier » ne constitue pas une autorisation implicite.

La garde de route relit le profil nominatif, y compris si le gate global est
désactivé. Une panne refuse l’accès en 503. Les mutations exigent un véritable
claim MFA et une vérification de moins de cinq minutes. Le contexte de
références n’est installé qu’après cette garde. Comptes, récupération,
validation et matrice restent protégés par le marqueur SuperAdmin vivant.

Les réglages métier locaux sont écrits dans la base sélectionnée et gardent
leurs capacités spécialisées. L’entreprise et ses mentions conservent leur
autorité Directory existante. Pour un compte délégué, Directory valide la
session et son MFA, son adhésion Production active, puis une réponse signée
des droits Production actuels, liée au profil, à la base et à un nonce frais.
Une révocation ou une source indisponible ne réutilise pas un ancien accord.
L’interface signale que cette identité d’entreprise est commune, même depuis Test.

## Vérification et livraison

Vérifications locales effectuées : 76 tests backend et 66 tests frontend,
typechecks et builds des deux dépôts passent. Un aperçu Chromium isolé du
vrai écran de paramètres et de son formulaire entreprise confirme le refus
sans droit, l’ouverture avec accord explicite et la fermeture si la résolution
échoue. Les identités et réponses de cet aperçu sont fictives. Cette preuve
locale ne constitue pas une publication ni une recette sur les comptes réels.

- Tests HTTP : refus sans droit, délégation, MFA absent/périmé, révocation,
  indisponibilité et maintien du refus de création de comptes.
- Tests Directory : autorisation commune depuis Test et Production, adhésion,
  révocation, MFA et panne ; source signée avec contrôle anti-rejeu.
- Tests interface : assistant visible avec accord explicite, fermé en erreur,
  navigation des références accordée sans ouvrir Administration.
- Catalogue : enregistrer les deux entrées `parametrage-erp` et `administration`
  dans les tables existantes avant activation, sans migration de schéma. Faire
  la même opération dans les Tests et leur modèle vierge. N’accorder que les
  comptes explicitement désignés ; conserver les autres choix et capacités.
- Ne pas intégrer les autres lots `dev` dans une livraison corrective isolée.
  Coordonner le serveur et les sources de publication avec le chantier bleu/vert.

Le nettoyage de données explicitement demandé a été effectué séparément :
14 comptes locaux obsolètes supprimés physiquement, quatre noms techniques
normalisés, six profils communs actifs et trois locaux inactifs réservés
conservés. Les identifiants techniques des profils conservés et leurs données
d’authentification sont inchangés. Sauvegarde et preuves nominatives restent
dans le dossier privé de livraison ; elles ne sont pas dans Git.
