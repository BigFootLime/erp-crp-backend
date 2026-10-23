# Documents Clients — #1432 / frontend #1749

La fiche Test `000` porte `CLI-001`. Les archives initiales `CLIENT_CREATION_SNAPSHOT`
et `CLIENT_PROFILE` v1 conservent `CLI-013` au titre de leur source initiale.
Le diagnostic en lecture seule ne montrait aucune nouvelle édition acceptée.
Corriger la fiche exige une réémission `CLIENT_PROFILE` n+1, nouvelle clé et motif ;
la création historique, ses octets/SHA et ses liens ne sont jamais réécrits.

`client-profile-pdf-v3` reprend le gabarit structuré A4 des OF, les accents Commerce
validés dans la refonte (#2563eb), et la police Inter 4.1 du frontend.
Les graisses 400/700 et caractères Latin/documentaires sont embarqués comme le logo CRP,
sans chemin d’assets ou téléchargement runtime. Source : InterVariable.woff2 fournie avec
le frontend 2.0.18, instances wght400/700, opsz14, licence SIL OFL conservée dans les fontes
et `src/shared/pdf/inter-LICENSE.txt`. Les métriques du corps, tables, titres et règle de pied
emploient la même police, localement au PDF. Aucun remplacement global de Helvetica.

Le logo Client provient de la version GED figée et autorisée dans l’instantané ; il est
dessiné entier à droite du logo CRP. Sans logo enregistré, le document métier reste lisible.
La TVA est formatée uniquement à l’affichage. Les jobs v2 conservent leur rendu historique.

Le titre GED courant suit la dernière édition Client ; les versions et événements restent
inchangés. Le code visible de la PT est résolu depuis `clients.client_code`, comme sa liste.

Validation : 38 tests PDF ciblés, compilation stricte, rendu réel en PNG, extraction des
deux polices Inter et de `FR38 105 397 137`, contrôle d’une fiche simple sur une page,
test du logo GED et absence de fuite de palette/police entre rendus v2 et v3 concurrents.
Le déploiement doit couvrir les producteurs PDF des workers en plus des API HTTP.
