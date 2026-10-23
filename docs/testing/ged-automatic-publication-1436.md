# Publication automatique GED — #1436 / frontend #1753

Décision humaine explicite du 23 octobre 2026 : publier automatiquement après analyse
antivirus saine, dans tous les modules, pour les nouveaux dépôts et nouvelles versions.
Suivi local DOC220 (pas de session Project Office authentifiée).

Le format Excel n’était pas la cause du brouillon : le fichier signalé était `clean`,
sorti de quarantaine, mais encore dans le cycle manuel. Le service central de dépôt
applique maintenant une politique de disponibilité documentaire distincte de l’approbation
humaine et des décisions métier (résultats qualité, facturation, production, etc.).

Préconditions serveur : version BROUILLON, document actif, absence de gel et de consignation
par un autre utilisateur, session antivirus clean/released correspondant exactement au blob
(document, SHA-256, MIME et taille), droit de dépôt et accès aux parents revalidés. Aucun
champ du navigateur ne peut demander de contourner ces préconditions. Un upload historique
sans preuve de scan ne devient pas automatiquement applicable.

Le verrou document/version, l’obsolescence de la précédente version, le pointeur courant et
l’événement PUBLISH sont dans la même transaction que le dépôt. Une panne d’audit annule
l’opération. La libération après réanalyse saine emploie la même politique. Le cas d’un COMMIT
incertain garde ses clés et protections de réconciliation existantes.

La politique `ged-clean-upload-20261023` inscrit `AUTOMATIC_AFTER_CLEAN_SCAN` et
`human_approval=false` dans l’audit ; aucun approbateur ou résultat métier n’est inventé.
Les capacités des routes manuelles restent inchangées. Un ancien brouillon peut toujours
suivre son cycle manuel. Aucune publication rétroactive générale n’est lancée.

Validation : 23 cas de politique/service (différents modules, refus de scan/quarantaine,
octets non correspondants, gel, consignation, accès, audit, idempotence), plus 15 tests
existants de quarantaine, cycle transactionnel et approbation manuelle. Compilation stricte.
La publication doit couvrir les API Test/Prod/VPS ; le futur template Test utilise le même
code. Aucun changement de schéma ou nouvelle classe documentaire n’est nécessaire.
