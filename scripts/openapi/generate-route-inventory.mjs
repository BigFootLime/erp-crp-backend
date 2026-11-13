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
const helperSources = new Set();
const helperModuleCache = new Map();

function isOrderedMountHelperModule(filePath) {
  const absolute = path.resolve(filePath);
  const canonicalHelper = path.join(root, "src", "routes", "route-mount-order.ts");
  if (absolute !== canonicalHelper) return false;
  const cached = helperModuleCache.get(absolute);
  if (cached !== undefined) return cached;
  const sf = sourceFile(absolute);
  const exported = sf.statements.some((statement) =>
    ts.isFunctionDeclaration(statement)
    && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    && statement.name?.text === "mountOrderedRouteGroup",
  );
  helperModuleCache.set(absolute, exported);
  return exported;
}

function importedRouter(imported) {
  if (!imported) return null;
  const moduleInfo = analyzeModule(imported.file);
  return imported.exportName === "default"
    ? moduleInfo.defaultRouter
    : moduleInfo.exportedRouters.get(imported.exportName) ?? null;
}

function analyzeModule(filePath) {
  const absolute = path.resolve(filePath);
  const cached = moduleCache.get(absolute);
  if (cached) return cached;

  const sf = sourceFile(absolute);
  const imports = new Map();
  const orderedMountFunctions = new Map();
  const orderedMountNamespaces = new Map();
  const invalidOrderedMountFunctions = new Set();
  const routers = new Set();
  const actions = new Map();
  const exportedRouters = new Map();
  let defaultRouter = null;

  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const resolved = resolveImport(absolute, statement.moduleSpecifier.text);
      const clause = statement.importClause;
      if (!resolved || !clause) continue;
      if (clause.name) {
        imports.set(clause.name.text, { file: resolved, exportName: "default" });
      }
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const binding of clause.namedBindings.elements) {
          imports.set(binding.name.text, {
            file: resolved,
            exportName: binding.propertyName?.text ?? binding.name.text,
          });
          if ((binding.propertyName?.text ?? binding.name.text) === "mountOrderedRouteGroup") {
            if (isOrderedMountHelperModule(resolved)) {
              orderedMountFunctions.set(binding.name.text, resolved);
            } else {
              invalidOrderedMountFunctions.add(binding.name.text);
            }
          }
        }
      }
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) && isOrderedMountHelperModule(resolved)) {
        orderedMountNamespaces.set(clause.namedBindings.name.text, resolved);
      }
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isCallExpression(declaration.initializer)) continue;
        const callee = declaration.initializer.expression.getText(sf);
        if (callee === "Router" || callee === "express.Router") {
          routers.add(declaration.name.text);
          actions.set(declaration.name.text, []);
          if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
            exportedRouters.set(declaration.name.text, declaration.name.text);
          }
        }
      }
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals && ts.isIdentifier(statement.expression)) {
      defaultRouter = statement.expression.text;
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause) && !statement.moduleSpecifier) {
      for (const binding of statement.exportClause.elements) {
        const localName = binding.propertyName?.text ?? binding.name.text;
        if (routers.has(localName)) exportedRouters.set(binding.name.text, localName);
      }
    }
  }

  function orderedMountHelper(call) {
    if (ts.isIdentifier(call.expression)) return orderedMountFunctions.get(call.expression.text) ?? null;
    if (
      ts.isPropertyAccessExpression(call.expression)
      && ts.isIdentifier(call.expression.expression)
      && call.expression.name.text === "mountOrderedRouteGroup"
    ) {
      return orderedMountNamespaces.get(call.expression.expression.text) ?? null;
    }
    return null;
  }

  function assertNoOrderedMountBindingMutation() {
    function visit(node) {
      if (ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind) && ts.isIdentifier(node.left) && orderedMountFunctions.has(node.left.text)) {
        throw new Error(`${path.relative(root, absolute)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} mountOrderedRouteGroup import binding cannot be reassigned`);
      }
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && ts.isIdentifier(node.operand) && orderedMountFunctions.has(node.operand.text)) {
        throw new Error(`${path.relative(root, absolute)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} mountOrderedRouteGroup import binding cannot be reassigned`);
      }
      if (
        ts.isBinaryExpression(node)
        && ts.isAssignmentOperator(node.operatorToken.kind)
        && ts.isPropertyAccessExpression(node.left)
        && ts.isIdentifier(node.left.expression)
        && orderedMountNamespaces.has(node.left.expression.text)
        && node.left.name.text === "mountOrderedRouteGroup"
      ) {
        throw new Error(`${path.relative(root, absolute)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} mountOrderedRouteGroup namespace binding cannot be reassigned`);
      }
      ts.forEachChild(node, visit);
    }
    ts.forEachChild(sf, visit);
  }

  function isTypeReference(node) {
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isTypeNode(current)) return true;
      if (ts.isSourceFile(current) || ts.isStatement(current)) return false;
    }
    return false;
  }

  function isDirectFunctionCallee(node) {
    return ts.isCallExpression(node.parent) && node.parent.expression === node;
  }

  function isDirectNamespaceCallee(node) {
    const access = node.parent;
    return ts.isPropertyAccessExpression(access)
      && access.expression === node
      && access.name.text === "mountOrderedRouteGroup"
      && ts.isCallExpression(access.parent)
      && access.parent.expression === access;
  }

  function assertNoOrderedMountValueCapture() {
    function visit(node) {
      if (ts.isIdentifier(node) && invalidOrderedMountFunctions.has(node.text) && !ts.isImportSpecifier(node.parent)) {
        throw new Error(`${path.relative(root, absolute)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} mountOrderedRouteGroup must resolve to src/routes/route-mount-order.ts`);
      }
      if (ts.isIdentifier(node) && orderedMountFunctions.has(node.text) && !ts.isImportSpecifier(node.parent) && !isTypeReference(node) && !isDirectFunctionCallee(node)) {
        throw new Error(`${path.relative(root, absolute)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} mountOrderedRouteGroup import binding may only be invoked directly`);
      }
      if (ts.isIdentifier(node) && orderedMountNamespaces.has(node.text) && !ts.isNamespaceImport(node.parent) && !isTypeReference(node) && !isDirectNamespaceCallee(node)) {
        throw new Error(`${path.relative(root, absolute)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} mountOrderedRouteGroup namespace binding may only be invoked directly`);
      }
      ts.forEachChild(node, visit);
    }
    ts.forEachChild(sf, visit);
  }

  function visitStatement(statement) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return;
    const call = statement.expression;
    const helperSource = orderedMountHelper(call);
    if (helperSource) {
      helperSources.add(helperSource);
      const [parent, mounts] = call.arguments;
      if (!parent || !ts.isIdentifier(parent) || !routers.has(parent.text)) {
        throw new Error(`${path.relative(root, absolute)}:${sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1} mountOrderedRouteGroup requires a declared Router identifier`);
      }
      if (!mounts || !ts.isArrayLiteralExpression(mounts)) {
        throw new Error(`${path.relative(root, absolute)}:${sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1} mountOrderedRouteGroup requires a literal mount array`);
      }
      const list = actions.get(parent.text);
      if (!list) return;
      for (const mount of mounts.elements) {
        if (!ts.isObjectLiteralExpression(mount)) {
          throw new Error(`${path.relative(root, absolute)}:${sf.getLineAndCharacterOfPosition(mount.getStart(sf)).line + 1} has a non-literal ordered mount`);
        }
        const properties = new Map();
        for (const property of mount.properties) {
          if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) {
            throw new Error(`${path.relative(root, absolute)}:${sf.getLineAndCharacterOfPosition(property.getStart(sf)).line + 1} has an unsupported ordered mount property`);
          }
          properties.set(property.name.text, property.initializer);
        }
        const mountPath = properties.get("prefix");
        const child = properties.get("router");
        const pathValue = mountPath ? literalPath(mountPath) : null;
        if (pathValue === null || !child || !ts.isIdentifier(child)) {
          throw new Error(`${path.relative(root, absolute)}:${sf.getLineAndCharacterOfPosition(mount.getStart(sf)).line + 1} ordered mount requires literal prefix and router identifier`);
        }
        if (!routers.has(child.text) && !importedRouter(imports.get(child.text))) {
          throw new Error(`${path.relative(root, absolute)}:${sf.getLineAndCharacterOfPosition(child.getStart(sf)).line + 1} has an unresolved ordered mounted router`);
        }
        list.push({
          kind: "mount",
          path: pathValue,
          child: child.text,
          middleware: [],
          line: sf.getLineAndCharacterOfPosition(mount.getStart(sf)).line + 1,
        });
      }
      return;
    }
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
        ts.isIdentifier(candidate) && (routers.has(candidate.text) || importedRouter(imports.get(candidate.text)))
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

  assertNoOrderedMountBindingMutation();
  assertNoOrderedMountValueCapture();
  function assertOrderedMountCallsAreTopLevel(node, parent) {
    const helperSource = ts.isCallExpression(node) ? orderedMountHelper(node) : null;
    if (ts.isCallExpression(node) && !helperSource && (
      (ts.isIdentifier(node.expression) && node.expression.text === "mountOrderedRouteGroup")
      || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "mountOrderedRouteGroup")
    )) {
      throw new Error(`${path.relative(root, absolute)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} mountOrderedRouteGroup must resolve to the supported route-mount-order helper`);
    }
    if (helperSource) {
      const supported = ts.isExpressionStatement(parent) && parent.expression === node && parent.parent === sf;
      if (!supported) {
        throw new Error(`${path.relative(root, absolute)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} mountOrderedRouteGroup must be a top-level expression statement`);
      }
    }
    ts.forEachChild(node, (child) => assertOrderedMountCallsAreTopLevel(child, node));
  }
  assertOrderedMountCallsAreTopLevel(sf, null);
  for (const statement of sf.statements) visitStatement(statement);
  if (defaultRouter && !routers.has(defaultRouter)) {
    throw new Error(`${path.relative(root, absolute)} default export is not a Router`);
  }
  const analyzed = { absolute, imports, routers, actions, defaultRouter, exportedRouters };
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
    const childImport = moduleInfo.imports.get(action.child);
    if (!childImport) throw new Error(`unresolved mounted router ${action.child} in ${moduleInfo.absolute}:${action.line}`);
    const childModule = analyzeModule(childImport.file);
    const childRouter = importedRouter(childImport);
    if (!childRouter) {
      throw new Error(`unresolved exported router ${childImport.exportName} in ${childImport.file}`);
    }
    expandRouter(childModule, childRouter, childPrefix, childMiddleware, nextStack, output);
  }
}

function generatedInventory() {
  const entry = analyzeModule(entryFile);
  if (!entry.defaultRouter) throw new Error(`${path.relative(root, entryFile)} does not export a Router as default`);
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
  const sources = [...new Set([...moduleCache.keys(), ...helperSources])].sort();
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
      const committed = fs.existsSync(file)
        ? fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n")
        : null;
      if (committed !== content) {
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
