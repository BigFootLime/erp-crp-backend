# CRM sur l'identité client canonique — WP-276 / #925

Les demandes de l'audit du 2 octobre et les décisions de Keenan ajoutent la prospection et les relances au Commerce. `clients.client_id` reste la clé varchar existante ; un prospect n'est ni dupliqué ni converti par copie. La promotion lors d'une commande reste le mécanisme canonique.

Un profil CRM séparé porte la qualification particulier/professionnel, l'étape commerciale, le responsable actif, les restrictions de contact et la date choisie de revue de conservation. Une fiche historique sans profil reste explicitement non qualifiée. Ni consentement, ni durée légale, ni revenu, ni score ne sont inventés. La date de revue n'ordonne aucune destruction automatique.

Les relances sont internes et datées : création, report justifié avec possibilité de réaffectation, clôture avec résultat, annulation motivée. Les interactions déjà réalisées peuvent être enregistrées avec leur date effective et la signature de l'utilisateur connecté. Aucune de ces commandes n'envoie de courriel. L'opposition au contact interdit les nouvelles relances externes ; un courriel exige la qualification explicite du canal. Un dossier inactif/bloqué interdit de créer ou reporter une relance, tout en conservant la lecture et la clôture de son historique.

Le client est verrouillé avant les contacts et le profil ; archivage et décisions CRM sont sérialisés. Versions attendues obligatoires, clés d'idempotence par acteur, empreinte du corps et réponse durable protègent les réessais et les conflits. État, événement immuable, audit et outbox sont dans la même transaction. Les notifications ne transportent aucun texte libre ou contact. L'entité temps réel `CLIENT` utilise le module `clients` et sa politique d'accès existante. Les écritures conservent les droits de gestion du référentiel ; aucune permission nouvelle n'est accordée.

L'historique signé reste append-only ; les tables n'accordent aucun DELETE/TRUNCATE au runtime. La base autoritaire conserve les événements et les réponses idempotentes. Un besoin de restriction ou d'anonymisation doit suivre le processus existant de revue de conservation et de traçabilité ; aucun effacement automatique de preuve n'est introduit.

Les listes sont paginées et les requêtes bornées, sans boucle SQL par contact ou interaction. Le frontend contrôle les réponses et utilise les champs validés, les sélecteurs CERP et l'aide en tooltip. Les noms, contacts et le responsable du profil préremplissent la saisie. Les chemins devis/commande existants gardent la même identité.

Compilation, contrat API et schéma SQL sont vérifiés avant publication. La recette commune métier/sécurité sera exécutée à la fin de tous les lots, selon la demande explicite de Keenan ; la compilation ne vaut pas recette.
