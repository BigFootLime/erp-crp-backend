# Bibliothèque des nuances — livraison 2.0.85 du 13 novembre 2026

Livraison urgente autorisée par l’utilisateur dans le chat coordinateur. La référence initiale était CERP 2.0.84. Cette livraison contient la bibliothèque FR/EN/DIN-Werkstoff/USA, le choix de désignation principale, la protection contre les doublons, la reprise des anciennes nuances comme références à classer et l’indépendance de sélection entre états et nuances. Les autres travaux de consolidation sont exclus.

Sources figées : frontend `927630549fbe47457b5634de96a96ac9f5a96528`, backend `93c84b24548058fd8904bba0b7f7095fc950c6fb`. Manifeste final `urgent-2.0.85-final-root/manifest.json`, SHA-256 `387cfc50d36854792bbaef99cce5f780250e9df21f54bc1e4cbf790379891d00`.

La migration ciblée `20261113_stock_nuance_library.sql` a été exécutée par le runner propriétaire avec `--only`, après dry-run et vérification des empreintes canoniques. Elle est appliquée aux bases CRP Test/Production et EC Test/Production. Les empreintes des anciennes nuances, associations états et liens articles sont identiques avant/après en excluant les cinq nouvelles propriétés. Aucune fusion ou suppression de nuances n’a été effectuée. Les quatre sauvegardes protégées et le jeu de reprise complet accepté restent disponibles sur l’hôte.

Les quatre services exécutent les copies suffixées `nuance-library-2.0.85-93c84b24` ou `nuances-2.0.85-93c84b24`. Les drop-ins `~~~nuance-library-2.0.85-93c84b24.conf` remplacent uniquement ExecStart. Les argv effectifs, les paramètres systemd, les anciens runtimes et les fichiers non concernés ont été contrôlés. Les copies natives ne changent que trois fichiers JavaScript ; les copies EC changent le domaine Nuance et l’adaptateur de compatibilité. Les ports effectifs sont CRP Production 18081, CRP Test 8082, EC Production 18110, EC Test 18111.

CRP Production, EC Production et EC Test répondent 200 à la readiness. CRP Test conserve sa dégradation préexistante `REALTIME_NOT_READY` (503), confirmée également avec l’ancien runtime après retour automatique ; base, stockage GED, média et antivirus restent disponibles. Les quatre contextes refusent les requêtes anonymes aux nuances (401). Aucun changement de configuration du temps réel n’a été ajouté.

L’interface LAN sert le build 2.0.85 depuis `/mnt/data/cerp/releases/20261113-nuances-2.0.85-92763054/frontend/dist`. Son index servi correspond aux octets du paquet. La configuration Apache précédente est conservée dans le staging privé.

Le couple public a été basculé atomiquement vers `cerp-api-nuances-2.0.85-93c84b24` et `cerp-ui-nuances-2.0.85-92763054`. Le runtime API part d’une copie du système de fichiers effectif du slot précédent ; seuls les trois fichiers autorisés diffèrent dans dist. Readiness publique 200, accès anonyme 401, index et assets initiaux identiques aux empreintes du manifeste. Preuve serveur : `/var/lib/cerp-release-staging/nuances-2.0.85-92763054/published.json` ; copie locale `public-deployment-proof.json`.

Installateur final : 183038752 octets, SHA-256 `d21b15c1871571011b16785f72a3cf41cb6be8251d2bb4e53a5932aeab1e1fed`. Electron Builder a terminé avec code 0 ; 545 fichiers renderer/Electron sont identiques au contenu ASAR, manifeste SHA-512 et sidecar vérifiés. Les deux payloads Windows ont été publiés puis téléchargés en HTTPS avec contrôle intégral des empreintes avant publication atomique de latest.yml. Le flux public annonce 2.0.85.

Le publisher officiel a ensuite été exécuté en dry-run puis avec `--apply` vers `Z:\CERP-INSTALLATION`. Un seul installateur Windows 2.0.85 subsiste dans `01-Windows`, avec blockmap et latest.yml vérifiés. Les fichiers 2.0.84 ont été retirés après validation. Aucun installateur ou latest.yml à la racine du partage. Android reste 2.0.13.

L’utilisateur a annulé les campagnes supplémentaires de tests/login/CRUD pendant l’urgence. Les validations de la fonctionnalité précédentes restent décrites dans les rapports existants ; la dernière correction UI d’indépendance a été reconstruite sans nouvelle campagne. Les vérifications ci-dessus concernent la livraison et la disponibilité.

Retour arrière : restaurer le YAML `active-pair-before.yaml` du staging privé VPS ; remettre la configuration Apache sauvegardée si nécessaire ; retirer uniquement les nouveaux drop-ins ExecStart, puis daemon-reload/restart des services concernés. Conserver les colonnes et les nouvelles données de bibliothèque. Les anciennes copies runtime et les payloads précédents du serveur restent disponibles. Ne pas relancer des migrations générales ni restaurer une sauvegarde au-dessus de données de production récentes.

L’annuaire, recovery-email.env, les règles d’authentification, les montages de données et les paramètres de ressources restent inchangés.

Suivis hors livraison : dégradation temps réel préexistante de CRP Test ; reprise différée de la validation SQL en laboratoire et de son problème de PATH, signalée par le coordinateur. Ces points ne remettent pas en cause l’application et la vérification de la migration ciblée sur les quatre contextes. Ce document est une provenance externe au paquet ; aucun commit documentaire ni déplacement des références publiées n’a été effectué par cet agent.
