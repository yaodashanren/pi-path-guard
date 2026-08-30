// Dev-only Node module-resolution hook. The extension imports from
// "@earendil-works/pi-coding-agent" (type-only, stripped at runtime) and
// "@earendil-works/pi-tui" (value import, used by the scrollable overview
// viewer). Outside pi's own loader those bare specifiers are unresolvable, so
// this hook redirects them to the installed pi runtime. It is wired into the
// test runner only; it is not part of the shipped extension.
//
// Usage: node --import ./pi-modules-hook.mjs ...  (registers itself)

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Locate the pi install's @earendil-works scope. Prefer the running pi, then
// fall back to well-known install roots.
function findPiScope() {
	const fromEnv = process.env.PI_PACKAGES_ROOT;
	if (fromEnv && existsSync(fromEnv)) return fromEnv;
	const roots = [
		process.execPath, // node binary inside the pi node install
		// Common standalone pi install layout:
		"/Users/aicoding/.local/share/pi-node",
	];
	for (const r of roots) {
		if (!r) continue;
		// node-vX/lib/node_modules/@earendil-works
		const base = r.includes("node_modules/@earendil-works") ? r : null;
		if (base && existsSync(base)) return base;
	}
	// Fall back: search a couple of known candidates directly.
	const candidates = [
		"/Users/aicoding/.local/share/pi-node/node-v22.23.1-darwin-arm64/lib/node_modules/@earendil-works",
	];
	for (const c of candidates) if (existsSync(c)) return c;
	return null;
}

const scope = findPiScope();
const require =
	scope &&
	(() => createRequire(pathToFileURL(`${scope}/pi-coding-agent/index.js`)))();

/** Resolve a bare "@earendil-works/<pkg>" to its real file URL, or null. */
function resolveBare(specifier) {
	if (!scope) return null;
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
