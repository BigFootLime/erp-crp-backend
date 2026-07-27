-- À N'EXÉCUTER QUE SUR DÉCISION HUMAINE EXPLICITE.
-- Après l'import de contacts partageant un courriel entre plusieurs clients,
-- la contrainte globale historique ne peut plus être restaurée sans arbitrage
-- métier et sans traitement de données.

\echo 'Rollback automatique refusé : contrôler les courriels partagés et faire valider la procédure.'
\quit 3
