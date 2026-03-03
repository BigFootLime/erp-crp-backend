import type { RequestHandler } from "express";

import { CODE_FORMATS } from "../../../shared/codes/code-validator";

export const listCodeFormats: RequestHandler = (_req, res) => {
  const items = Object.entries(CODE_FORMATS).map(([key, v]) => ({
    key,
    regex: v.regex.source,
    example: v.example,
    hintText: v.hintText,
  }));

  res.json({ items });
};
