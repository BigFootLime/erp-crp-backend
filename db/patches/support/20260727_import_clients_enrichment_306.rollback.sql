-- À N'EXÉCUTER QUE SUR DÉCISION HUMAINE EXPLICITE.
-- Le retrait de la table d'idempotence peut casser la sécurité de rejeu et le
-- retrait des types peut invalider des lots existants. Ce rollback reste donc
-- volontairement manuel après archivage et contrôle des lots #306.

\echo 'Rollback automatique refusé : archiver les lots #306 puis faire valider la procédure.'
\quit 3
