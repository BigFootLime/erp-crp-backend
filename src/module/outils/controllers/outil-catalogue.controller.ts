import type { NextFunction, Request, Response } from "express";

import { requestHasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
import { hasOutillageCapability } from "../domain/outillage-lifecycle";
import { getToolCatalogueAsset, getToolCatalogueBundle } from "../services/outil-catalogue.service";

function privateResponse(res: Response): void {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

export async function getCatalogue(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    privateResponse(res);
    const bundle = await getToolCatalogueBundle();
    res.json({
      ...bundle,
      // Runtime authorization is deliberately separate from the immutable source manifest.
      permissions: {
        canConfigure: hasOutillageCapability(requestHasGrantedAccountModuleAccess(req), req.user?.role, "configure"),
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function getCatalogueAsset(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    privateResponse(res);
    const filename = Array.isArray(req.params.filename) ? req.params.filename[0] : req.params.filename;
    const asset = await getToolCatalogueAsset(filename ?? "");
    res.type(asset.contentType).send(asset.bytes);
  } catch (error) {
    next(error);
  }
}
