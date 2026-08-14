#!/usr/bin/env node

import SwaggerParser from "@apidevtools/swagger-parser";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const require = createRequire(import.meta.url);
const { swaggerSpec } = require(path.join(root, "dist", "swagger", "swagger.js"));

await SwaggerParser.validate(JSON.parse(JSON.stringify(swaggerSpec)));
const coverage = swaggerSpec["x-cerp-route-coverage"];
process.stdout.write(`[openapi] contract valid; operations=${coverage.documented}; source=${coverage.source_sha256.slice(0, 12)}\n`);
