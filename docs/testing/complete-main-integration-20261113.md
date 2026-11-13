# Consolidation du backend CERP — 13 novembre 2026

Cette intégration réconcilie les historiques `dev`, `main`, la source associée à
2.0.84 et le travail local de reconfiguration des articles. Les originaux non
committés sont conservés dans leur emplacement initial et dans un commit de
préservation ; aucun service ni aucune base de production ne sont modifiés.

## Comportements conservés et réconciliés

- La reconfiguration reste atomique et idempotente. Les versions applicables
  sont copiées en brouillons ; leurs OF existants ne suivent pas automatiquement
  ce remplacement. Le comportement AUTO habituel des autres créations de
  révisions reste conservé.
- Les transactions empruntées ne sont ni committées, ni annulées, ni libérées
  par les primitives appelées. Les tests couvrent aussi l'échec d'une copie.
- Le contrôle des clés interdites de la reprise vérifie l'entrée brute avant
  que Zod puisse ignorer `__proto__`. Les tests adversariaux restent actifs.
- Les couleurs client partagées du planning sont intégrées avec leur migration
  et leur contrat de permissions. La nouvelle édition OF 1.9 fige sa couleur.
  L'édition 1.8 conserve le SHA-256 de la baseline compilée `92ddf20a` :
  `bc0da4b617405ee5020c1466797e811ef5a6b8be3b832dc93138b39590030b3b`.
  Le moteur PDF actuel, ses polices Inter et sa charte versionnée restent
  prioritaires sur l'ancienne implémentation concurrente du même style.
- Les routes de proposition, création et acceptation des relations industrielles
  sont montées sous `/clients/intercompany/relations`. Le profil INDUSTRIAL
  exige Clients et Paramétrage ERP ; COMMERCIAL exige Fournisseurs et
  Paramétrage ERP. Les routes d'un profil différent restent refusées.
- Une relation fournisseur industrielle exige le client local et les profils
  d'approbation ; une relation acheteur commerciale n'exige pas les profils
  propres au fournisseur. L'environnement et l'entreprise restent vérifiés
  dans les lectures/verrous de propositions et les écritures transactionnelles.
- L'image conserve ses vérifications antivirus et ses épinglages de sécurité.
  Le paquet zlib absent est remplacé par `1.4-r0`, vérifié dans l'index officiel
  Alpine v3.24, sans revenir à `1.3.2-r0`.

## Validation

Les rapports locaux de cette qualification sont conservés dans
`output/cerp-integration-20261113` à la racine du workspace. Les tests existants
ne sont ni supprimés ni ignorés pour obtenir un résultat vert. Les tests qui
nécessitent explicitement PostgreSQL ou d'autres services sont distingués des
tests unitaires. Le rapport frontend correspondant décrit les parcours navigateur.

La publication dans Git suit une PR d'intégration vers `dev`, puis une PR de
livraison vers `main`. Cette opération ne constitue pas un déploiement ni une
publication d'installateur.
