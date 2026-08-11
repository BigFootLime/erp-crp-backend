# Version de release dans les healthchecks

## Objectif

`/health/live`, `/health/ready`, les logs et `cerp_build_info` doivent exposer le SHA Git réellement déployé. La valeur n'est pas sensible et permet de relier un incident à un artefact exact.

## Coolify

Référence opérateur : [variables prédéfinies Coolify](https://coolify.io/docs/knowledge-base/environment-variables#predefined-variables).

1. Dans **Configuration → Advanced**, activer **Include Source Commit in Build**.
2. Vérifier que l'injection des arguments Dockerfile reste activée.
3. Redéployer l'application depuis le commit attendu.
4. Vérifier :

```bash
curl -fsS https://<api>/health/live
```

Le champ `version` doit être le SHA attendu, jamais `unknown`. Coolify fournit `SOURCE_COMMIT`; le Dockerfile le copie dans `CERP_RELEASE_VERSION`. Une variable runtime explicite `CERP_RELEASE_VERSION` peut surcharger cette valeur pour un artefact signé ou tagué.

## Build manuel / HYPERBOX2

```bash
docker build \
  --build-arg SOURCE_COMMIT="$(git rev-parse --verify HEAD)" \
  -t cerp-api:"$(git rev-parse --short HEAD)" .
```

Après démarrage, comparer `/health/live.version` avec `git rev-parse HEAD` ou l'étiquette immuable de l'image.

## Alerte et rollback

Un `version: unknown` est une erreur de configuration P1 : ne pas promouvoir l'artefact. Revenir à l'image précédente par digest si le SHA ne correspond pas, puis corriger l'option d'injection avant de reconstruire.
