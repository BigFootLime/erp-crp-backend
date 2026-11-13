import type { Router } from "express";

export type OrderedRouteMount = Readonly<{
  prefix: string;
  router: Router;
}>;

/**
 * Express resolves identical prefixes in registration order. Keep every
 * compatibility-sensitive group declarative and mount it as one sequence.
 */
export function mountOrderedRouteGroup(
  router: Router,
  mounts: readonly OrderedRouteMount[]
): void {
  for (const mount of mounts) router.use(mount.prefix, mount.router);
}
