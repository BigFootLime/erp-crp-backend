import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const root = process.cwd();
const entryFile = path.join(root, "src", "routes", "v1.routes.ts");
const outputFile = path.join(root, "src", "swagger", "generated-route-inventory.ts");
const coverageFile = path.join(root, "docs", "http", "openapi-route-coverage.json");
const checkOnly = process.argv.includes("--check");
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

function fail(message) {
  process.stderr.write(`[openapi] ${message}\n`);
  process.exitCode = 1;
}

function sourceFile(filePath) {
  return ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function expressionLabel(node, sf) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return "anonymous";
  if (ts.isCallExpression(node)) {
    const callee = node.expression.getText(sf);
    const args = node.arguments
      .map((argument) => {
        if (ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument)) return argument.text;
        return argument.getText(sf).replace(/\s+/g, " ").slice(0, 80);
      })
      .join(",");
    return `${callee}(${args})`;
  }
  return node.getText(sf).replace(/\s+/g, " ").slice(0, 120);
}

function literalPath(node) {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

const moduleCache = new Map();

function analyzeModule(filePath) {
  const absolute = path.resolve(filePath);
  const cached = moduleCache.get(absolute);
  if (cached) return cached;

  const sf = sourceFile(absolute);
  const imports = new Map();
  const routers = new Set();
  const actions = new Map();
  let defaultRouter = null;

  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const resolved = resolveImport(absolute, statement.moduleSpecifier.text);
      const clause = statement.importClause;
      if (resolved && clause?.name) imports.set(clause.name.text, resolved);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isCallExpression(declaration.initializer)) continue;
        const callee = declaration.initializer.expression.getText(sf);
        if (callee === "Router" || callee === "express.Router") {
          routers.add(declaration.name.text);
          actions.set(declaration.name.text, []);
        }
      }
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals && ts.isIdentifier(statement.expression)) {
      defaultRouter = statement.expression.text;
    }
  }

  function visitStatement(statement) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return;
    const call = statement.expression;
    if (!ts.isPropertyAccessExpression(call.expression) || !ts.isIdentifier(call.expression.expression)) return;
    const routerName = call.expression.expression.text;
    if (!routers.has(routerName)) return;
    const method = call.expression.name.text.toLowerCase();
    if (method !== "use" && !HTTP_METHODS.has(method)) return;
    const list = actions.get(routerName);
    if (!list) return;

    if (HTTP_METHODS.has(method)) {
      const pathValue = call.arguments[0] ? literalPath(call.arguments[0]) : null;
      if (pathValue === null) {
        throw new Error(`${path.relative(root, absolute)}:${sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1} has a non-literal route path`);
      }
      list.push({
        kind: "route",
        method,
        path: pathValue,
        middleware: call.arguments.slice(1).map((argument) => expressionLabel(argument, sf)),
        line: sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1,
      });
      return;
    }

    const first = call.arguments[0];
    const literalMountPath = first ? literalPath(first) : null;
    const mountPath = literalMountPath ?? "";
    {
      const candidates = literalMountPath !== null ? call.arguments.slice(1) : call.arguments;
      const childIndex = candidates.findIndex((candidate) =>
        ts.isIdentifier(candidate) && (routers.has(candidate.text) || imports.has(candidate.text))
      );
      if (childIndex >= 0) {
        const child = candidates[childIndex];
        list.push({
          kind: "mount",
          path: mountPath,
          child: child.text,
          middleware: candidates.slice(0, childIndex).map((argument) => expressionLabel(argument, sf)),
          line: sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1,
        });
        return;
      }
    }

    list.push({
      kind: "middleware",
      middleware: call.arguments.map((argument) => expressionLabel(argument, sf)),
      line: sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1,
    });
  }

  for (const statement of sf.statements) visitStatement(statement);
  if (!defaultRouter || !routers.has(defaultRouter)) {
    throw new Error(`${path.relative(root, absolute)} does not export a Router as default`);
  }
  const analyzed = { absolute, imports, routers, actions, defaultRouter };
  moduleCache.set(absolute, analyzed);
  return analyzed;
}

function joinPaths(left, right) {
  const joined = `/${[left, right].join("/").split("/").filter(Boolean).join("/")}`;
  return joined === "/" ? "/" : joined.replace(/\/$/, "");
}

function openApiPath(expressPath) {
  return expressPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function expandRouter(moduleInfo, routerName, prefix, inheritedMiddleware, stack, output) {
  const recursionKey = `${moduleInfo.absolute}:${routerName}:${prefix}`;
  if (stack.includes(recursionKey)) throw new Error(`router cycle detected at ${recursionKey}`);
  const nextStack = [...stack, recursionKey];
  const activeMiddleware = [...inheritedMiddleware];
  const actions = moduleInfo.actions.get(routerName) ?? [];

  for (const action of actions) {
    if (action.kind === "middleware") {
      activeMiddleware.push(...action.middleware);
      continue;
    }
    if (action.kind === "route") {
      const middleware = [...activeMiddleware, ...action.middleware];
      const fullPath = openApiPath(joinPaths(prefix, action.path));
      output.push({
        method: action.method,
        path: fullPath,
        source: `${path.relative(root, moduleInfo.absolute).replace(/\\/g, "/")}:${action.line}`,
        middleware,
        authenticated: middleware.some((item) => /(^|\.)authenticateToken(?:\(|$)/.test(item)),
        rbac: middleware.filter((item) => /^(require|authorize|moduleAccessGate)/.test(item)),
      });
      continue;
    }

    const childPrefix = joinPaths(prefix, action.path);
    const childMiddleware = [...activeMiddleware, ...action.middleware];
    if (moduleInfo.routers.has(action.child)) {
      expandRouter(moduleInfo, action.child, childPrefix, childMiddleware, nextStack, output);
      continue;
    }
    const childFile = moduleInfo.imports.get(action.child);
    if (!childFile) throw new Error(`unresolved mounted router ${action.child} in ${moduleInfo.absolute}:${action.line}`);
    const childModule = analyzeModule(childFile);
    expandRouter(childModule, childModule.defaultRouter, childPrefix, childMiddleware, nextStack, output);
  }
}

function generatedInventory() {
  const entry = analyzeModule(entryFile);
  const routes = [];
  expandRouter(entry, entry.defaultRouter, "", [], [], routes);
  routes.push(
    {
      method: "get",
      path: "/environment",
      source: "src/config/app.ts",
      middleware: [],
      authenticated: false,
      rbac: [],
    },
    {
      method: "get",
      path: "/realtime/readiness",
      source: "src/config/app.ts",
      middleware: [],
      authenticated: false,
      rbac: [],
    },
  );
  routes.sort((left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method));
  const duplicates = routes.filter((route, index) =>
    index > 0 && route.path === routes[index - 1].path && route.method === routes[index - 1].method
  );
  if (duplicates.length > 0) {
    throw new Error(`duplicate Express operations: ${duplicates.map((route) => `${route.method.toUpperCase()} ${route.path}`).join(", ")}`);
  }
  return routes;
}

function renderTypeScript(routes, sourceHash) {
  return `// Generated by scripts/openapi/generate-route-inventory.mjs. Do not edit manually.\n` +
    `export type GeneratedRouteContract = {\n` +
    `  method: "get" | "post" | "put" | "patch" | "delete" | "head" | "options";\n` +
    `  path: string;\n  source: string;\n  middleware: readonly string[];\n  authenticated: boolean;\n  rbac: readonly string[];\n};\n\n` +
    `export const GENERATED_ROUTE_SOURCE_SHA256 = ${JSON.stringify(sourceHash)};\n` +
    `export const GENERATED_ROUTE_INVENTORY = ${JSON.stringify(routes, null, 2)} as const satisfies readonly GeneratedRouteContract[];\n`;
}

function renderCoverage(routes, sourceHash) {
  const authenticated = routes.filter((route) => route.authenticated).length;
  return `${JSON.stringify({
    scope: "/api/v1",
    source_sha256: sourceHash,
    discovered_operations: routes.length,
    documented_operations: routes.length,
    coverage_percent: 100,
    authenticated_operations: authenticated,
    public_operations: routes.length - authenticated,
  }, null, 2)}\n`;
}

try {
  const routes = generatedInventory();
  const sources = [...moduleCache.keys()].sort();
  const sourceHash = crypto.createHash("sha256")
    .update(sources.map((file) => {
      const portablePath = path.relative(root, file).replace(/\\/g, "/");
      const portableSource = fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
      return `${portablePath}\n${portableSource}`;
    }).join("\n"))
    .digest("hex");
  const outputs = [
    [outputFile, renderTypeScript(routes, sourceHash)],
    [coverageFile, renderCoverage(routes, sourceHash)],
  ];
  for (const [file, content] of outputs) {
    if (checkOnly) {
      if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== content) {
        fail(`${path.relative(root, file)} is stale; run pnpm openapi:generate`);
      }
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, "utf8");
    }
  }
  if (!process.exitCode) process.stdout.write(`[openapi] ${routes.length} operations, 100% inventoried (${sourceHash.slice(0, 12)})\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
