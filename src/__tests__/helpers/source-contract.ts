import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { repoRoot } from "./repo-paths";

/** Read the complete real declaration, including its attached contract comments. */
export function readSourceFunction(relativePath: string, functionName: string): string {
  const text = readFileSync(resolve(repoRoot, relativePath), "utf8");
  const file = ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true);
  const declarations: ts.FunctionDeclaration[] = [];
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) declarations.push(node);
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (declarations.length !== 1 || !declarations[0]?.body?.statements.length) {
    throw new Error(`Expected one non-empty function ${functionName} in ${relativePath}`);
  }
  return declarations[0].getFullText(file);
}
