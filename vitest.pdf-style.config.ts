import { mergeConfig } from "vitest/config";
import base from "./vitest.config";

export default mergeConfig(base, { test: {
  setupFiles: ["scripts/pdf-style-capture.setup.ts"],
  maxWorkers: 2,
} });
