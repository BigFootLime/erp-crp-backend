import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import { readNavigationPreferences, saveNavigationPreferences } from "../services/navigation-preferences.service";

export const getNavigationPreferences = asyncHandler(async (req, res) => {
  if (!req.user) throw new HttpError(401, "UNAUTHENTICATED", "Connexion requise");
  res.setHeader("Cache-Control", "private, no-store");
  res.json(await readNavigationPreferences(req.user.id));
});

export const putNavigationPreferences = asyncHandler(async (req, res) => {
  if (!req.user) throw new HttpError(401, "UNAUTHENTICATED", "Connexion requise");
  res.setHeader("Cache-Control", "private, no-store");
  res.json(await saveNavigationPreferences(req.user.id, req.body));
});
