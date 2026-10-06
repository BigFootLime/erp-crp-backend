# L3 — Engagements client, urgences et calendrier d'atelier

Project Office WP-268 ; backend #821 ; web #1097. La recette transversale et les suites sont différées jusqu'à la fin de L2–L7 sur instruction explicite du 7 octobre 2026. Une compilation ou une répétition de migration ne vaut pas recette métier.

## Échéances et couverture

Une allocation de livraison reste la racine commerciale. La couverture existante (par exemple 30 réservées et 70 à produire sur une commande de 100) reste indépendante de la répartition des dates. Une demande de 20 urgentes crée deux échéances : 20 à la nouvelle date et 80 à l'ancienne. Le total restant est contrôlé côté serveur ; aucune réservation ni quantité d'OF n'est modifiée par cette action.

Le premier AR réellement envoyé fournit la quantité et la date initiales. Son contenu, son identifiant et son allocation sont conservés. Les anciens AR sont rapprochés uniquement si la ligne est unique, la quantité concordante et la date attestée. Une ambiguïté reste affichée comme quantité sans référence initiale ; elle ne devient jamais une promesse fictive. Un changement de quantité commerciale requiert d'abord la réconciliation de l'avenant de commande.

Chaque révision conserve auteur, motif, date, répartition avant/après et clé d'idempotence. Les échéances sont remplacées, jamais réécrites. Au départ canonique d'un BL, chaque quantité est liée à l'échéance applicable à cet instant. Une révision ultérieure ne peut déplacer ces quantités déjà expédiées.

## Indicateurs

Le tableau affiche ponctualité initiale et révisée, pondérées par quantité. Une livraison confirmée est évaluée à la date de sa preuve de livraison. Les quantités ouvertes au-delà de leur échéance restent dans le dénominateur ; les échéances futures restent en attente. Un taux sans quantité évaluable est indéfini. Les quantités sans AR rapprochable sont indiquées distinctement. Les surlivraisons sont signalées et ne gonflent pas le taux au-delà de la quantité de l'AR.

Le dépassement de cinq jours ouvrés se mesure par rapport à l'AR initial selon les jours et fermetures du calendrier de l'atelier. Il produit une alerte d'information client ; aucun courriel n'est envoyé automatiquement par ce lot.

## Calendrier et planning

Un responsable habilité sélectionne explicitement un calendrier actif dans le poste de préparation des OF. Aucun horaire d'atelier n'est inventé. Le seuil de 48 heures compte les intervalles d'ouverture dans le fuseau du calendrier et exclut ses fermetures, depuis `commande_client.created_at`. Un regroupement reprend la plus ancienne échéance de ses sources. Le délai reste indéfini tant que le calendrier n'est configuré.

L'urgence réutilise le protocole planning central : simulation versionnée, conflits, puis application explicite. La simulation est attachée à une révision commerciale vérifiée pour ce client. Les autres clients, opérations démarrées et producteurs regroupés partagés restent protégés. Les créneaux se mettent à jour sans réviser le dossier technique ou l'AR. Les conflits et les fins proposées après l'échéance restent visibles.

## Recette commune à exécuter en fin de programme

1. Créer 100 pièces, couvrir 30 par stock et 70 par OF, envoyer un AR de Test via le dispositif sans email externe.
2. Répartir 20 urgentes et 80 initiales : contrôler total, réservations inchangées, historique et AR original.
3. Rejouer la même requête, puis changer son contenu avec la même clé : aucun doublon, conflit explicite.
4. Expédier 10 urgentes ; modifier uniquement les 90 restantes ; contrôler la date figée des 10.
5. Confirmer des livraisons conformes et tardives avec preuves ; laisser un solde ouvert en retard. Contrôler les deux dénominateurs et les quantités sans référence.
6. Simuler une urgence en présence d'un autre client sur la même machine et d'un OF regroupé multi-client. Vérifier que leurs créneaux ne bougent pas.
7. Faire évoluer le planning pendant une simulation : application refusée comme obsolète.
8. Vérifier les 48 heures sur un week-end, une fermeture et une transition de fuseau, à partir de la saisie de commande et non de la validation d'OF.
9. Dépasser cinq jours ouvrés par rapport à l'AR et vérifier l'alerte sans émission automatique de mail.
