"use strict";
/**
 * The JavaScript / TypeScript scanner. Python runs it with Node and reads the
 * JSON it prints; the output has the same shape as the Python scanner's.
 *
 *   node scanner.cjs scan <folder>                    symbols, links, unresolved calls, meta
 *   node scanner.cjs symbols  < {"files": {path: text}}   symbols of old file versions (for diffs)
 *   node scanner.cjs instrument <folder>              rewrite a COPY of the code for runtime tracing
 *
 * It uses the TypeScript compiler, which also reads plain .js files. The
 * compiler's type checker tells us which declaration each call points at,
 * across imports, re-exports and method calls on typed objects.
 *
 * Naming follows the Python scanner: a module is the file path without its
 * extension, with "/" turned into "." (src/services/orders.ts ->
 * src.services.orders), and a symbol is module + "." + its name.
 */

const fs = require("fs");
const path = require("path");
const ts = require(process.env.AFTERSHOCK_TYPESCRIPT || "typescript");

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "coverage", ".next", ".nuxt", ".output", ".svelte-kit",
  ".turbo", ".cache", "out", "venv", ".venv", "__pycache__", ".tox", "vendor", "bower_components",
]);
const EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const CONFIG_FILE = /(^|\/)[\w-]+\.config\.[cm]?[jt]s$/;          // vite.config.ts, jest.config.js ...
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all"]);
const NEST_METHODS = { Get: "GET", Post: "POST", Put: "PUT", Patch: "PATCH", Delete: "DELETE",
  Options: "OPTIONS", Head: "HEAD", All: "ALL" };
const NEXT_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);
const TEST_CALLS = new Set(["it", "test"]);
const SUITE_CALLS = new Set(["describe", "suite", "context"]);
const CALLABLE_KINDS = new Set(["function", "method", "route"]);
const RUN = "__aftershockRun";

// ---------------------------------------------------------------- files and names

function isSourceFile(rel) {
  if (/\.d\.[cm]?ts$/.test(rel) || /\.(min|bundle)\.[cm]?js$/.test(rel)) return false;
  return EXTENSIONS.has(path.extname(rel));
}

/** A built or minified file (very long lines) is output, not source: reading it adds only noise. */
function isGenerated(file) {
  const size = fs.statSync(file).size;
  if (size > 2_000_000) return true;
  if (size < 50_000) return false;
  const head = fs.readFileSync(file, "utf8").slice(0, 200_000);
  return head.split("\n").some((line) => line.length > 1000);
}

function listFiles(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const rel = path.relative(root, path.join(dir, entry.name)).split(path.sep).join("/");
        if (isSourceFile(rel) && !isGenerated(path.join(dir, entry.name))) found.push(rel);
      }
    }
  };
  walk(root);
  return found.sort();
}

/** src/services/orders.ts -> src.services.orders; orders.service.ts -> orders_service */
function moduleName(rel) {
  const noExt = rel.slice(0, rel.length - path.extname(rel).length);
  return noExt.split("/").map((part) => part.replace(/\./g, "_")).join(".");
}

function isTestPath(rel) {
  const parts = rel.split("/");
  const file = parts[parts.length - 1];
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)
    || parts.slice(0, -1).some((p) => p === "__tests__" || p === "test" || p === "tests" || p === "e2e");
}

/** A name part may not contain "." (it separates parts) and stays one line. */
function cleanPart(text) {
  return text.replace(/\./g, "_").replace(/\s+/g, " ").trim().slice(0, 200) || "anonymous";
}

function scriptKind(rel) {
  switch (path.extname(rel)) {
    case ".tsx": return ts.ScriptKind.TSX;
    case ".jsx": return ts.ScriptKind.JSX;
    case ".js": case ".mjs": case ".cjs": return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

function lineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function endLineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
}

function textOf(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.getText().slice(1, -1);
  return null;
}

function nameText(name) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function unwrap(expr) {
  while (expr && (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)
    || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(expr)) || ts.isTypeAssertionExpression(expr)
    || ts.isNonNullExpression(expr))) {
    expr = expr.expression;
  }
  return expr;
}

/** require("x"), require("x").y */
function isRequire(node) {
  while (node && ts.isPropertyAccessExpression(node)) node = node.expression;
  return !!node && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require";
}

function isFunctionLike(node) {
  return !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

function decoratorsOf(node) {
  return (ts.canHaveDecorators && ts.canHaveDecorators(node) ? ts.getDecorators(node) : node.decorators) || [];
}

function hasModifier(node, kind) {
  return !!(ts.canHaveModifiers(node) && ts.getModifiers(node) || []).some((m) => m.kind === kind);
}

/** "Get" from @Get(":id") and its argument. */
function decoratorCall(dec) {
  const expr = dec.expression;
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    return { name: expr.expression.text, arg: textOf(expr.arguments[0]) };
  }
  if (ts.isIdentifier(expr)) return { name: expr.text, arg: null };
  return null;
}

function joinPath(prefix, sub) {
  const parts = [prefix, sub].filter((p) => p !== null && p !== undefined && p !== "")
    .map((p) => p.replace(/^\/+|\/+$/g, ""));
  return "/" + parts.filter(Boolean).join("/");
}

/** app/api/orders/[id]/route.ts -> /api/orders/[id] (Next.js app router) */
function nextRoutePath(rel) {
  const parts = rel.split("/");
  const at = parts.lastIndexOf("app");
  if (at < 0 || !/^route\.[cm]?[jt]sx?$/.test(parts[parts.length - 1])) return null;
  const segments = parts.slice(at + 1, -1).filter((s) => !/^\(.*\)$/.test(s));   // (groups) are not in the URL
  return "/" + segments.join("/");
}

/** pages/api/orders.ts -> /api/orders (Next.js pages router API route) */
function nextPagesApiPath(rel) {
  const m = rel.match(/(?:^|\/)pages\/(api\/.*)\.[cm]?[jt]sx?$/);
  if (!m) return null;
  return "/" + m[1].replace(/\/index$/, "");
}

// ---------------------------------------------------------------- routes and tests

/** router.get("/orders", handler) -> { method: "GET", path: "/orders", handlers: [...] } */
function routeCall(call) {
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return null;
  const method = call.expression.name.text;
  if (!HTTP_METHODS.has(method) || call.arguments.length < 2) return null;
  const routePath = textOf(call.arguments[0]);
  if (routePath === null || !(routePath.startsWith("/") || routePath === "*")) return null;
  return { method: method.toUpperCase(), path: routePath, handlers: call.arguments.slice(1) };
}

/** fastify.route({ method: "GET", url: "/x", handler }) */
function routeObjectCall(call) {
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return null;
  if (call.expression.name.text !== "route" || call.arguments.length !== 1) return null;
  const obj = call.arguments[0];
  if (!ts.isObjectLiteralExpression(obj)) return null;
  let method = null; let url = null; const handlers = [];
  for (const prop of obj.properties) {
    const key = prop.name && nameText(prop.name);
    if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop) && !ts.isMethodDeclaration(prop)) continue;
    if (key === "method" && ts.isPropertyAssignment(prop)) {
      const init = prop.initializer;
      method = textOf(init) || (ts.isArrayLiteralExpression(init) ? textOf(init.elements[0]) : null);
    } else if ((key === "url" || key === "path") && ts.isPropertyAssignment(prop)) {
      url = textOf(prop.initializer);
    } else if (key === "handler" || key === "preHandler" || key === "onRequest") {
      handlers.push(ts.isPropertyAssignment(prop) ? prop.initializer : prop);
    }
  }
  if (!method || !url || !url.startsWith("/")) return null;
  return { method: method.toUpperCase(), path: url, handlers };
}

/** it("does x", fn), test.only(...), it.concurrent(...) -> the title and the callback */
function testCall(call, names) {
  if (!ts.isCallExpression(call) || call.arguments.length < 2) return null;
  let callee = call.expression;
  while (ts.isPropertyAccessExpression(callee)) callee = callee.expression;
  if (!ts.isIdentifier(callee) || !names.has(callee.text)) return null;
  // describe.each([...])("x", fn) has a call as its callee: not supported, skipped
  if (ts.isCallExpression(call.expression)) return null;
  const title = textOf(call.arguments[0]);
  if (title === null) return null;
  const fn = call.arguments.find((a, i) => i > 0 && isFunctionLike(unwrap(a)));
  return { title, fn: fn ? unwrap(fn) : null };
}

// ---------------------------------------------------------------- symbols of one file

/**
 * Every symbol defined in one file, without the type checker (so it also works
 * on an old version of a file that is no longer on disk).
 *
 * Returns { symbols, owners, bodies }:
 *   symbols  plain objects in the Python Symbol shape
 *   owners   node -> symbol name: calls inside that node belong to that symbol
 *   decls    declaration node -> symbol name (what the type checker points at)
 *   bodies   functions to wrap for runtime tracing: { fn, name, isTest }
 */
function collectSymbols(sf, rel) {
  const module = moduleName(rel);
  const isTest = isTestPath(rel);
  const symbols = [];
  const seen = new Set();
  const owners = new Map();
  const decls = new Map();
  const bodies = [];

  const add = (name, kind, node, extra = {}) => {
    let qualified = `${module}.${name}`;
    for (let i = 2; seen.has(qualified); i++) qualified = `${module}.${name}#${i}`;
    seen.add(qualified);
    symbols.push({
      qualified_name: qualified, kind, file_path: rel, start_line: lineOf(sf, node), end_line: endLineOf(sf, node),
      is_test: isTest, module, route: extra.route || "", test_name: extra.testName || "",
    });
    return qualified;
  };
  const wrap = (fn, name, testBody = false) => {
    if (!fn || fn.asteriskToken) return;            // generators can't be wrapped in an arrow function
    if (!fn.body) return;
    bodies.push({ fn, name, isTest: testBody });
  };

  symbols.push({
    qualified_name: module, kind: "module", file_path: rel, start_line: 1,
    end_line: sf.getLineAndCharacterOfPosition(sf.getEnd()).line + 1, is_test: isTest, module, route: "", test_name: "",
  });
  seen.add(module);

  const nextPath = nextRoutePath(rel);
  const pagesApi = nextPagesApiPath(rel);
  const variables = [];

  const addClass = (node, className) => {
    const cls = add(className, "class", node);
    owners.set(node, cls);
    decls.set(node, cls);
    let prefix = null;
    for (const dec of decoratorsOf(node)) {
      const d = decoratorCall(dec);
      if (d && d.name === "Controller") prefix = d.arg || "";
    }
    const derived = (node.heritageClauses || []).some((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
    for (const member of node.members) {
      const memberName = nameText(member.name);
      if (ts.isConstructorDeclaration(member) && member.body && !derived) {
        wrap(member, cls);
        continue;
      }
      if (!memberName) continue;
      let fn = null;
      if (ts.isMethodDeclaration(member) && member.body) fn = member;
      else if (ts.isPropertyDeclaration(member) && isFunctionLike(unwrap(member.initializer))) fn = unwrap(member.initializer);
      if (!fn) continue;
      let route = "";
      for (const dec of decoratorsOf(member)) {
        const d = decoratorCall(dec);
        if (d && NEST_METHODS[d.name] && prefix !== null) route = `${NEST_METHODS[d.name]} ${joinPath(prefix, d.arg)}`;
      }
      const name = add(`${className}.${cleanPart(memberName)}`, route ? "route" : "method", member, { route });
      owners.set(member, name);
      decls.set(member, name);
      wrap(fn, name);
    }
  };

  const addFunction = (name, node, fn, exported) => {
    let route = "";
    if (exported && nextPath !== null && NEXT_METHODS.has(name)) route = `${name} ${nextPath}`;
    if (exported && pagesApi !== null && name === "default") route = `ALL ${pagesApi}`;
    const qualified = add(cleanPart(name), route ? "route" : "function", node, { route });
    owners.set(fn, qualified);
    decls.set(node, qualified);
    if (fn !== node) decls.set(fn, qualified);
    wrap(fn, qualified);
    return qualified;
  };

  // pass 1: functions and classes declared at the top of the file
  for (const stmt of sf.statements) {
    const exported = hasModifier(stmt, ts.SyntaxKind.ExportKeyword);
    const isDefault = hasModifier(stmt, ts.SyntaxKind.DefaultKeyword);
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      addFunction(stmt.name ? stmt.name.text : "default", stmt, stmt, exported);
    } else if (ts.isClassDeclaration(stmt)) {
      addClass(stmt, stmt.name ? stmt.name.text : "default");
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const init = unwrap(decl.initializer);
        const name = decl.name.text;
        if (isFunctionLike(init)) {
          const q = addFunction(name, decl, init, exported);
          symbols[symbols.length - 1].start_line = lineOf(sf, stmt);
          decls.set(decl, q);
        } else if (init && ts.isClassExpression(init)) {
          addClass(init, name);
          decls.set(decl, `${module}.${name}`);
        } else if (!isRequire(init)) {           // const x = require("x") is an import, not a variable
          variables.push({ decl, stmt, init, name });
        }
      }
    } else if (ts.isExportAssignment(stmt) && isFunctionLike(unwrap(stmt.expression))) {
      addFunction("default", stmt, unwrap(stmt.expression), true);
    } else if (ts.isExpressionStatement(stmt) && ts.isBinaryExpression(stmt.expression)
      && stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      // CommonJS: exports.createOrder = function () {}  /  module.exports.createOrder = ...
      const left = stmt.expression.left;
      const right = unwrap(stmt.expression.right);
      if (ts.isPropertyAccessExpression(left) && isFunctionLike(right)) {
        const target = left.expression.getText(sf);
        if (target === "exports" || target === "module.exports") {
          const q = addFunction(left.name.text, stmt, right, true);
          decls.set(left, q);
          decls.set(stmt.expression, q);
        } else {
          // older JavaScript: Foo.prototype.bar = function () {} and res.send = function () {}
          let base = left.expression;
          if (ts.isPropertyAccessExpression(base) && base.name.text === "prototype") base = base.expression;
          if (ts.isIdentifier(base)) {
            const q = add(`${cleanPart(base.text)}.${cleanPart(left.name.text)}`, "method", stmt);
            owners.set(right, q);
            decls.set(left, q);
            decls.set(stmt.expression, q);
            wrap(right, q);
          }
        }
      }
    }
  }

  // pass 2: variables (an object of functions also gets one symbol per function)
  for (const { decl, stmt, init, name } of variables) {
    const v = add(cleanPart(name), "variable", stmt);
    decls.set(decl, v);
    if (init) owners.set(init, v);
    if (init && ts.isObjectLiteralExpression(init)) {
      for (const prop of init.properties) {
        const key = prop.name && nameText(prop.name);
        if (!key) continue;
        let fn = null;
        if (ts.isMethodDeclaration(prop) && prop.body) fn = prop;
        else if (ts.isPropertyAssignment(prop) && isFunctionLike(unwrap(prop.initializer))) fn = unwrap(prop.initializer);
        if (!fn) continue;
        const m = add(`${cleanPart(name)}.${cleanPart(key)}`, "method", prop);
        owners.set(fn, m);
        decls.set(prop, m);
        wrap(fn, m);
      }
    }
  }

  // pass 3: routes registered anywhere (router.get("/x", ...)) and test cases
  const visit = (node, suite) => {
    if (ts.isCallExpression(node)) {
      const route = routeCall(node) || routeObjectCall(node);
      if (route) {
        const label = `${route.method} ${route.path}`;
        const name = add(cleanPart(label), "route", node, { route: label });
        owners.set(node, name);
        for (const h of route.handlers) {
          const fn = ts.isMethodDeclaration(h) ? h : unwrap(h);
          if (isFunctionLike(fn) || ts.isMethodDeclaration(fn)) {
            owners.set(fn, name);
            wrap(fn, name);
          }
        }
        return;               // handlers are part of this route; nothing nested is a separate route
      }
      const suiteCall = isTest ? testCall(node, SUITE_CALLS) : null;
      if (suiteCall && suiteCall.fn) {
        ts.forEachChild(suiteCall.fn.body, (child) => visit(child, [...suite, suiteCall.title]));
        return;
      }
      const test = isTest ? testCall(node, TEST_CALLS) : null;
      if (test) {
        const full = [...suite, test.title];
        const name = add(cleanPart(full.join(" > ")), "function", node, { testName: full.join(" ") });
        owners.set(node, name);
        if (test.fn) wrap(test.fn, name, true);
        return;
      }
    }
    ts.forEachChild(node, (child) => visit(child, suite));
  };
  visit(sf, []);

  return { symbols, owners, decls, bodies, module };
}

// ---------------------------------------------------------------- the scan

function loadConfig(root) {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const read = ts.readConfigFile(file, ts.sys.readFile);
    if (read.error) continue;
    return ts.parseJsonConfigFileContent(read.config, ts.sys, root).options;
  }
  return {};
}

function compilerOptions(root) {
  const options = { ...loadConfig(root) };
  for (const key of ["composite", "incremental", "tsBuildInfoFile", "outDir", "declaration", "declarationDir",
    "emitDeclarationOnly", "rootDir", "plugins"]) delete options[key];
  Object.assign(options, {
    allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true, types: [], maxNodeModuleJsDepth: 0,
    allowNonTsExtensions: true, noResolve: false,
  });
  if (options.jsx === undefined) options.jsx = ts.JsxEmit.Preserve;
  if (options.moduleResolution === undefined) {
    options.module = options.module ?? ts.ModuleKind.ESNext;
    options.moduleResolution = ts.ModuleResolutionKind.Bundler ?? ts.ModuleResolutionKind.NodeJs;
  }
  return options;
}

function readPackage(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function testRunner(pkg) {
  if (!pkg) return "";
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const script = (pkg.scripts && pkg.scripts.test) || "";
  if (deps.vitest || /\bvitest\b/.test(script)) return "vitest";
  if (deps.jest || deps["ts-jest"] || /\bjest\b/.test(script)) return "jest";
  if (deps.mocha || /\bmocha\b/.test(script)) return "mocha";
  if (/node\s+(--[\w-]+\s+)*--test\b/.test(script)) return "node";
  return "";
}

function scan(root) {
  root = path.resolve(root);
  const files = listFiles(root);
  const options = compilerOptions(root);
  const program = ts.createProgram(files.map((f) => path.join(root, f)), options);
  const checker = program.getTypeChecker();
  const host = ts.createCompilerHost(options, true);
  const relOf = (fileName) => path.relative(root, fileName).split(path.sep).join("/");
  const inProject = new Set(files);

  const result = { symbols: [], edges: [], unresolved: [], meta: {}, warnings: [] };
  const decls = new Map();                 // declaration node -> symbol name, across all files
  const perFile = [];
  const kinds = new Map();
  const methodsByName = new Map();          // "save" -> ["a.Repo.save", ...] for untyped calls

  for (const rel of files) {
    const sf = program.getSourceFile(path.join(root, rel));
    if (!sf) continue;
    const info = collectSymbols(sf, rel);
    perFile.push({ rel, sf, info });
    for (const s of info.symbols) {
      result.symbols.push(s);
      kinds.set(s.qualified_name, s.kind);
      if (s.kind === "method" && !s.is_test) {
        const short = s.qualified_name.split(".").pop();
        if (!methodsByName.has(short)) methodsByName.set(short, []);
        methodsByName.get(short).push(s.qualified_name);
      }
    }
    for (const [node, name] of info.decls) decls.set(node, name);
  }

  const resolveFile = (spec, fromFile) => {
    const r = ts.resolveModuleName(spec, fromFile, options, host).resolvedModule;
    if (!r) return null;
    const rel = relOf(r.resolvedFileName);
    return inProject.has(rel) ? rel : null;
  };

  const symbolFor = (sym) => {
    if (!sym) return null;
    if (sym.flags & ts.SymbolFlags.Alias) {
      try { sym = checker.getAliasedSymbol(sym); } catch { return null; }
    }
    for (const d of sym.declarations || []) {
      const name = decls.get(d) || (d.parent && decls.get(d.parent));
      if (name) return name;
      // `const x = () => ...`: the checker may point at the arrow function or the declaration
      if (ts.isVariableDeclaration(d) && d.initializer && decls.get(unwrap(d.initializer))) return decls.get(unwrap(d.initializer));
    }
    return null;
  };

  /** The full name a call *would* point at, for calls that point at nothing we know. */
  const candidateFor = (callee, sf, info, owner) => {
    const expr = unwrap(callee);
    const head = ts.isPropertyAccessExpression(expr) ? leftmost(expr) : expr;
    if (ts.isPropertyAccessExpression(expr) && expr.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const cls = owner && owner.split(".").length > 1 ? classOf(owner) : null;
      return cls ? `${cls}.${expr.name.text}` : `${info.module}.${expr.name.text}`;
    }
    if (ts.isIdentifier(head)) {
      const sym = checker.getSymbolAtLocation(head);
      const decl = sym && sym.declarations && sym.declarations[0];
      const imported = decl && importTarget(decl, sf);
      const rest = ts.isPropertyAccessExpression(expr) ? expr.getText(sf).slice(head.getText(sf).length) : "";
      if (imported) return imported + rest;
      if (!sym) return `${info.module}.${expr.getText(sf)}`;
    }
    return expr.getText(sf).replace(/\s+/g, "").slice(0, 200);
  };
  const classOf = (owner) => {
    const kind = kinds.get(owner);
    return kind === "method" || kind === "route" ? owner.slice(0, owner.lastIndexOf(".")) : null;
  };
  const leftmost = (expr) => {
    while (ts.isPropertyAccessExpression(expr) || ts.isCallExpression(expr)) expr = expr.expression;
    return expr;
  };
  /** import { a as b } from "./x"  ->  "x.a";  const { a } = require("./x") -> "x.a" */
  const importTarget = (decl, sf) => {
    let spec = null; let imported = null;
    if (ts.isImportSpecifier(decl)) {
      spec = decl.parent.parent.parent.moduleSpecifier;
      imported = (decl.propertyName || decl.name).text;
    } else if (ts.isImportClause(decl)) {
      spec = decl.parent.moduleSpecifier; imported = "default";
    } else if (ts.isNamespaceImport(decl)) {
      spec = decl.parent.parent.moduleSpecifier; imported = "";
    } else if (ts.isBindingElement(decl) && ts.isObjectBindingPattern(decl.parent)) {
      const v = decl.parent.parent;
      const init = v && v.initializer && unwrap(v.initializer);
      if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "require") {
        spec = init.arguments[0];
        imported = (decl.propertyName ? nameText(decl.propertyName) : decl.name.getText(sf));
      }
    }
    const text = spec && textOf(spec);
    if (!text) return null;
    const rel = resolveFile(text, sf.fileName);
    if (!rel) return null;
    return imported ? `${moduleName(rel)}.${imported}` : moduleName(rel);
  };

  const ownerOf = (node, owners) => {
    for (let n = node.parent; n; n = n.parent) {
      const o = owners.get(n);
      if (o) return o;
    }
    return null;
  };

  const seenImport = new Set();
  for (const { rel, sf, info } of perFile) {
    const module = info.module;
    const importEdge = (spec, node) => {
      const text = textOf(spec);
      const target = text && resolveFile(text, sf.fileName);
      if (!target || target === rel) return;
      const key = `${module}>${moduleName(target)}`;
      if (seenImport.has(key)) return;
      seenImport.add(key);
      result.edges.push({ source: module, target: moduleName(target), kind: "imports", line: lineOf(sf, node) });
    };

    const visit = (node) => {
      // module -> module imports
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        importEdge(node.moduleSpecifier, node);
      } else if (ts.isCallExpression(node) && node.arguments.length === 1
        && ((ts.isIdentifier(node.expression) && node.expression.text === "require")
          || node.expression.kind === ts.SyntaxKind.ImportKeyword)) {
        importEdge(node.arguments[0], node);
      }

      // class Child extends Parent
      if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.heritageClauses) {
        const cls = info.decls.get(node);
        for (const h of node.heritageClauses) {
          if (h.token !== ts.SyntaxKind.ExtendsKeyword) continue;
          for (const t of h.types) {
            const target = symbolFor(checker.getSymbolAtLocation(t.expression));
            if (cls && target && target !== cls) {
              result.edges.push({ source: cls, target, kind: "inherits", line: lineOf(sf, node) });
            }
          }
        }
      }

      // calls and references, credited to the symbol whose body they are in
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const owner = ownerOf(node, info.owners) || info.owners.get(node);
        const callee = unwrap(node.expression);
        if (owner && callee) {
          const nameNode = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
          let target = symbolFor(checker.getSymbolAtLocation(nameNode));
          if (!target && ts.isPropertyAccessExpression(callee) && isUntyped(callee.expression)) {
            const options_ = methodsByName.get(callee.name.text) || [];
            if (options_.length === 1) target = options_[0];      // only one method has this name: link it
          }
          if (target && target !== owner) {
            result.edges.push({ source: owner, target, kind: "calls", line: lineOf(sf, node) });
          } else if (!target && !isLibraryCall(nameNode)) {
            result.unresolved.push({ caller: owner, candidate: candidateFor(callee, sf, info, owner), line: lineOf(sf, node) });
          }
        }
      } else if (ts.isIdentifier(node) && isReference(node)) {
        const owner = ownerOf(node, info.owners);
        if (owner) {
          const sym = ts.isShorthandPropertyAssignment(node.parent)
            ? checker.getShorthandAssignmentValueSymbol(node.parent)    // { sendReceipt } means the value
            : checker.getSymbolAtLocation(node);
          const target = symbolFor(sym);
          const kind = target && kinds.get(target);
          if (target && target !== owner && (CALLABLE_KINDS.has(kind) || kind === "variable")) {
            result.edges.push({ source: owner, target, kind: "references", line: lineOf(sf, node) });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  function isUntyped(expr) {
    try {
      const type = checker.getTypeAtLocation(expr);
      return !!(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
    } catch {
      return false;
    }
  }

  /** A call into a library or the standard library: not a broken call, just not ours. */
  function isLibraryCall(nameNode) {
    let sym = checker.getSymbolAtLocation(nameNode);
    if (!sym) {
      // `res.json()` on an untyped object: not ours either, unless the name is one of our methods
      return ts.isPropertyAccessExpression(nameNode.parent) && !methodsByName.has(nameNode.text)
        && nameNode.parent.expression.kind !== ts.SyntaxKind.ThisKeyword;
    }
    if (sym.flags & ts.SymbolFlags.Alias) {
      try { sym = checker.getAliasedSymbol(sym); } catch { return false; }
    }
    const decls_ = sym.declarations || [];
    if (!decls_.length) return false;          // an import of something that no longer exists
    return decls_.every((d) => !inProject.has(relOf(d.getSourceFile().fileName)));
  }

  /** An identifier that reads a value (not a declaration name, a property key or a call). */
  function isReference(node) {
    const p = node.parent;
    if (!p) return false;
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === node) return false;
    if (ts.isPropertyAccessExpression(p) && p.name === node) {
      const gp = p.parent;
      if (gp && (ts.isCallExpression(gp) || ts.isNewExpression(gp)) && gp.expression === p) return false;
      return true;
    }
    if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isExportSpecifier(p) || ts.isNamespaceImport(p)) return false;
    if (p.name === node && !ts.isPropertyAccessExpression(p) && !ts.isShorthandPropertyAssignment(p)) return false;
    if (ts.isPropertyAssignment(p) && p.name === node) return false;
    if (ts.isTypeReferenceNode(p) || ts.isExpressionWithTypeArguments(p) || ts.isTypeQueryNode(p)) return false;
    if (ts.isQualifiedName(p)) return false;
    return true;
  }

  // drop duplicate edges of the same kind on the same line
  const unique = new Map();
  for (const e of result.edges) unique.set(`${e.source}|${e.target}|${e.kind}|${e.line}`, e);
  result.edges = [...unique.values()];

  const pkg = readPackage(root);
  const languages = [];
  if (files.some((f) => /\.[cm]?tsx?$/.test(f))) languages.push("typescript");
  if (files.some((f) => /\.[cm]?jsx?$/.test(f) && !CONFIG_FILE.test(f))) languages.push("javascript");
  result.meta = { languages, test_runner: testRunner(pkg), files: files.length };
  return result;
}

// ---------------------------------------------------------------- old versions of files

function symbolsOf(files) {
  const out = {};
  for (const [rel, text] of Object.entries(files)) {
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKind(rel));
    out[rel] = collectSymbols(sf, rel).symbols;
  }
  return out;
}

// ---------------------------------------------------------------- instrumenting a copy for tracing

/**
 * Rewrites every function body so that, while tests run, each call reports
 * "I am <symbol>" to the tracing runtime:
 *
 *   function createOrder(a) { BODY }
 *   function createOrder(a) { return __aftershockRun("x.createOrder", () => { BODY }, false); }
 *
 * Only text is inserted and never a newline, so every line number stays the
 * same. The helper is a hoisted function at the end of the file that finds
 * the runtime the test process preloaded (see runtime.cjs).
 */
function instrument(root) {
  root = path.resolve(root);
  let changed = 0;
  for (const rel of listFiles(root)) {
    if (CONFIG_FILE.test(rel)) continue;
    const file = path.join(root, rel);
    const text = fs.readFileSync(file, "utf8");
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKind(rel));
    const { bodies } = collectSymbols(sf, rel);
    if (!bodies.length) continue;

    const inserts = [];
    for (const { fn, name, isTest } of bodies) {
      const isAsync = hasModifier(fn, ts.SyntaxKind.AsyncKeyword);
      const head = `${RUN}(${JSON.stringify(name)}, ${isAsync ? "async " : ""}() => `;
      if (ts.isBlock(fn.body)) {
        inserts.push([fn.body.getStart(sf) + 1, `return ${head}{`]);
        inserts.push([fn.body.getEnd() - 1, `}, ${isTest});`]);
      } else {
        inserts.push([fn.body.getStart(sf), `${head}(`]);
        inserts.push([fn.body.getEnd(), `), ${isTest})`]);
      }
    }
    inserts.sort((a, b) => b[0] - a[0]);
    let out = text;
    for (const [pos, s] of inserts) out = out.slice(0, pos) + s + out.slice(pos);
    out += `\n// @ts-ignore\nfunction ${RUN}(n, f, t) { return (globalThis.__aftershockRuntime || require("node:async_hooks").__aftershockRuntime).run(n, f, t); }\n`;
    fs.writeFileSync(file, out);
    changed++;
  }
  return { files: changed };
}

// ---------------------------------------------------------------- command line

function main() {
  const [mode, arg] = process.argv.slice(2);
  let output;
  if (mode === "scan") {
    output = scan(arg);
  } else if (mode === "symbols") {
    output = symbolsOf(JSON.parse(fs.readFileSync(0, "utf8")).files);
  } else if (mode === "instrument") {
    output = instrument(arg);
  } else {
    process.stderr.write("usage: scanner.cjs scan <folder> | symbols < files.json | instrument <folder>\n");
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(output));
}

if (require.main === module) main();

module.exports = { scan, symbolsOf, instrument, moduleName, isTestPath, collectSymbols };
