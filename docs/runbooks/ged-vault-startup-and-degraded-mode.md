# Runbook opérateur — coffre GED au démarrage et mode dégradé

## Invariant

En production, l'API CERP n'ouvre aucun port tant que le coffre GED n'a pas
prouvé les quatre propriétés suivantes : racine configurée, sentinelle de volume
lisible, répertoires privés accessibles et écriture/lecture/suppression d'une
sonde éphémère. `CERP_GED_REQUIRE_SENTINEL=false` ne désactive jamais ce contrôle
en production.

La sonde utilise un nom opaque dans `staging/`, 32 octets aléatoires, un `fsync`,
une relecture exacte et une suppression. Aucun chemin physique n'est renvoyé au
navigateur ou écrit dans les logs structurés.

## Préparation du volume

1. Monter le volume GED attendu avant de démarrer le conteneur API.
2. Créer une fois la sentinelle dans `CERP_GED_VAULT_ROOT`, sous le compte
   d'administration du stockage, puis la laisser lisible par le compte de
   service. Un chemin extérieur à cette racine est refusé.
3. Configurer `CERP_GED_VAULT_ROOT`, `CERP_GED_SENTINEL` et
   `CERP_GED_REQUIRE_SENTINEL=true` avec des chemins absolus. La sentinelle
   doit être un fichier régulier **dans** `CERP_GED_VAULT_ROOT` (par défaut,
   `.cerp-ged-volume`) : un marqueur voisin ou sur un autre volume est refusé.
4. Donner au compte de service les droits privés requis sur la racine GED ; ne
   jamais configurer un répertoire local de repli.
5. Vérifier qu'une sauvegarde GED et une sauvegarde PostgreSQL cohérentes sont
   disponibles avant toute intervention sur un volume contenant des données.

## Démarrage refusé

Le processus journalise `startup_preflight_failed` avec un code et une empreinte
d'erreur assainis, puis sort avec le code 1. Il ne faut pas contourner la
sentinelle.

1. Vérifier le montage et l'identité du volume hors du conteneur.
2. Vérifier que la sentinelle est un fichier régulier lisible, pas un dossier ou
   un lien de substitution.
3. Vérifier lecture, écriture, synchronisation et suppression avec le compte de
   service dans une zone de test dédiée du même volume.
4. Corriger le montage ou les droits, puis redémarrer l'API.
5. Attendre `critical_storage_preflight_succeeded`, puis exiger
   `/health/ready` à HTTP 200 avec `checks.ged_storage.status=up` avant de rendre
   l'instance disponible.

## Panne après démarrage

La readiness devient rouge et l'ERP affiche « Services de fichiers dégradés ».
Les dépôts GED et les nouvelles émissions PDF manuelles sont désactivés côté UI
et restent refusés côté serveur. Les PDF automatiques déjà acceptés restent dans
la file durable avec un état `PENDING`, `PROCESSING` ou `FAILED`; ils ne sont
jamais présentés comme « archivés dans la GED » sans octets, empreinte et liens
GED validés dans la même transaction.

Les consultations métier sans écriture documentaire peuvent continuer. Les
versions déjà archivées ne doivent jamais être supprimées ou recréées pour
« débloquer » l'interface.

## Retour à la normale

1. Restaurer le volume et ses droits sans déplacer ni réécrire les blobs.
2. Vérifier `/health/ready` puis la bannière ERP ; les contrôles se rafraîchissent
   automatiquement.
3. Laisser le worker reprendre la file autoritative. Contrôler que chaque item
   aboutit à `ARCHIVED` et possède ses identifiants GED avant de clore l'incident.
4. Tester un dépôt propre isolé et un téléchargement authentifié/audité.
5. Si l'intégrité DB/GED est incertaine, arrêter les writers et lancer le
   rapprochement opérateur ; ne jamais marquer manuellement un item `ARCHIVED`.
