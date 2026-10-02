// Dev-only Node module-resolution hook. The extension imports from
// "@earendil-works/pi-coding-agent" (type-only, stripped at runtime) and
// "@earendil-works/pi-tui" (value import, used by the scrollable overview
// viewer). Outside pi's own loader those bare specifiers are unresolvable, so
// this hook redirects them to the installed pi runtime. It is wired into the
// test runner only; it is not part of the shipped extension.
//
// Usage: node --import ./pi-modules-hook.mjs ...  (registers itself)

import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

const PI_SCOPE = "@earendil-works";
const PI_CORE_PKG = "pi-coding-agent";

/** True when `p` is a directory holding the @earendil-works scope. */
function isScopeDir(p) {
	return typeof p === "string" && existsSync(join(p, PI_CORE_PKG));
}

/**
 * Walk upward from a file or directory path and return the nearest
 * `.../node_modules/@earendil-works` directory, or null.
 * Handles both hoisted (`<dir>/node_modules/@earendil-works`) and standalone
 * Node layouts (`<dir>/lib/node_modules/@earendil-works`), and a path that
 * already points inside the scope.
 */
function scopeFromPath(start) {
	let dir = resolvePath(start);
	if (!existsSync(dir)) dir = dirname(dir);
	while (true) {
		// The ancestor itself is the scope, e.g. a realpathed pi binary inside
		// .../lib/node_modules/@earendil-works/pi-coding-agent/dist/...
		if (basename(dir) === PI_SCOPE && basename(dirname(dir)) === "node_modules") {
			if (isScopeDir(dir)) return dir;
		}
		for (const candidate of [
			join(dir, "node_modules", PI_SCOPE),
			join(dir, "lib", "node_modules", PI_SCOPE),
		]) {
			if (isScopeDir(candidate)) return candidate;
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Locate an executable named `name` on PATH. */
function which(name) {
	const pathEnv = process.env.PATH;
	if (!pathEnv) return null;
	for (const dir of pathEnv.split(":")) {
		if (!dir) continue;
		const candidate = join(dir, name);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/** Any `node-*` install under the common standalone pi-node root. */
function scanStandaloneRoots() {
	const home = process.env.HOME;
	if (!home) return null;
	const root = join(home, ".local", "share", "pi-node");
	if (!existsSync(root)) return null;
	let entries;
	try {
		entries = readdirSync(root);
	} catch {
		return null;
	}
	for (const entry of entries) {
		const scope = join(root, entry, "lib", "node_modules", PI_SCOPE);
		if (isScopeDir(scope)) return scope;
	}
	return null;
}

// Locate the pi install's @earendil-works scope, preferring an explicit
// override, then the running pi/node executables, then the standalone layout.
function findPiScope() {
	const fromEnv = process.env.PI_PACKAGES_ROOT;
	if (fromEnv && existsSync(fromEnv)) return fromEnv;

	const executables = [process.execPath, which("pi")].filter(Boolean);
	for (const exe of executables) {
		const scope = scopeFromPath(exe);
		if (scope) return scope;
	}

	return scanStandaloneRoots();
}

const scope = findPiScope();
const require =
	scope &&
	(() => createRequire(pathToFileURL(join(scope, PI_CORE_PKG, "index.js"))))();

/** Resolve a bare "@earendil-works/<pkg>" to its real file URL, or null. */
function resolveBare(specifier) {
	if (!scope || !require) return null;
	try {
		return pathToFileURL(require.resolve(specifier)).href;
	} catch {
		return null;
	}
}

export async function resolve(specifier, context, nextResolve) {
	if (specifier.startsWith("@earendil-works/")) {
		const url = resolveBare(specifier);
		if (url) return { url, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}
