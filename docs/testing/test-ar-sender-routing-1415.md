# AR clients en base Test — #1415

La confirmation d’envoi des deux routes AR, historique et document officiel, utilise le même service. En Test, celui-ci charge l’adresse du compte actif depuis l’identifiant de l’acteur authentifié ; les destinataires saisis dans le formulaire ne peuvent pas remplacer cette adresse. La garde commune du transport vérifie de nouveau la destination et ajoute le préfixe Test. L’historique d’envoi conserve la destination réelle.

Une adresse absente ou invalide produit `TEST_AR_SENDER_EMAIL_REQUIRED` avant la lecture du document archivé et avant tout appel au fournisseur. Le verrou d’envoi est annulé pour permettre une nouvelle tentative après correction du compte. Les envois Production gardent leurs destinataires métier. Les autres emails Test conservent leur boîte de recette actuelle ; aucun changement de récupération de compte n’est inclus.

Le mode SOL-05 reste borné aux adresses `example.local` et à son fournisseur loopback. Les vérifications unitaires du transport remplacent `fetch` : aucun email réel n’est envoyé pendant ces tests.

Contrôles ciblés : `test-email-routing.test.ts`, `resend.service.test.ts`, `commande-ar.send.service.test.ts`, et les tests existants du service AR. La qualification complète reste nécessaire sur la paire exacte à livrer.

Le correctif compagnon #1416 ajoute un écouteur permanent sur chaque `pg Client` du pool. `database.client-error.test.ts` vérifie qu’un événement de connexion perdu ne provoque pas un événement Node non géré, que le rejet de requête reste visible, et que le véritable wrapper transactionnel effectue l’annulation et la libération ou la destruction du client selon le résultat du rollback. Aucun message brut, SQL ou secret n’est journalisé.
