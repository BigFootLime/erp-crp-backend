# ADR-0088 — Politique MFA et cycle de vie des appareils

- Date : 2026-08-16
- Statut : Accepted
- Propriétaire : Keenan Martin

## Contexte

SOL-32 imposait correctement le TOTP aux superadministrateurs, mais ne proposait pas d’enrôlement volontaire aux autres comptes, de politique par base, ni de nom d’appareil exploitable. Le portail documentaire doit décrire un cycle Authy-compatible complet sans déplacer la frontière de sécurité vers le frontend.

## Décision

- conserver TOTP RFC 6238 et les codes de récupération existants ;
- stocker dans `erp_settings` une politique par base : `disabled`, `optional`, `required_for_admins` ou `required_for_all` ;
- initialiser à `required_for_admins` afin de ne pas relâcher le comportement SOL-32 ;
- un facteur actif reste obligatoire même si la politique est ensuite assouplie ; l’utilisateur doit le révoquer par le parcours protégé ;
- autoriser l’enrôlement volontaire d’une session authentifiée lorsque la politique le permet ;
- nommer chaque facteur par un libellé non sensible de 1 à 80 caractères ;
- réserver la lecture/modification de politique au superadministrateur et exiger mot de passe + facteur courant pour la mutation ;
- refuser côté API toute révocation lorsque la politique exige le facteur pour ce compte ;
- auditer enrôlement, remplacement, révocation, codes et changement de politique ;
- nettoyer périodiquement challenges et facteurs provisoires expirés.

## Conséquences

La migration est additive et rejouable. Les facteurs historiques reçoivent le libellé générique `Application d’authentification`. La policy reste isolée par base via `erp_settings`. Aucune API Authy propriétaire n’est requise.

## Sécurité

Les secrets restent chiffrés avec la clé runtime existante. Les routes de policy combinent authentification, RBAC live, rate limiting et validation. Aucun secret, QR ou code de récupération n’est journalisé. La révocation reste refusée lorsqu’elle abaisserait un compte sous la politique obligatoire.

## Rollback

Le rollback SQL est permis seulement si aucune policy non par défaut n’est déclarée et qu’aucun libellé personnalisé ne doit être conservé. Dans tout autre cas, conserver la colonne et le setting puis redéployer la version applicative précédente. Une sauvegarde et le preflight du runbook migration sont obligatoires.
