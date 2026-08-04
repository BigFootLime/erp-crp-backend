import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, "..")
const definitionPath = path.join(
  root,
  "dist/module/commande-client/workflow/commande-client-workflow.definition.js",
)
const outputPath = path.join(root, "contracts/commande-client-workflow.v1.json")
const { COMMANDE_WORKFLOW_CONTRACT } = require(definitionPath)

if (COMMANDE_WORKFLOW_CONTRACT?.authority !== "erp-crp-backend") {
  throw new Error("The compiled backend workflow contract is missing or has an unexpected authority.")
}

await mkdir(path.dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(COMMANDE_WORKFLOW_CONTRACT, null, 2)}\n`, "utf8")
console.log(`Generated ${path.relative(root, outputPath)}`)
