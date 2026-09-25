// path-guard — path classification utilities: outside-cwd check, protected
// path matching, home expansion, symlink-aware real-path resolution.

import { normalize, join, dirname, basename, relative as relativePath, sep } from "node:path";
import { statSync, realpathSync } from "node:fs";
import { HOME, PROTECTED_PATH_PATTERNS, EXACT_ONLY_PATTERNS, SAFE_CREDENTIAL_SUFFIXES } from "./constants.ts";

/** Whether an absolute path is outside cwd */
export function isOutsideCwd(absolutePath: string, cwd: string): boolean {
	const normCwd = normalize(cwd);
	const normPath = normalize(absolutePath);
	if (normPath === normCwd) return false;
	const rel = relativePath(normCwd, normPath);
	return rel.startsWith("..") || rel === normPath;
}

/** Protected-path match regardless of in/out project (used by bash redirect/overwrite checks and the write guard) */

/** Protected-path match regardless of in/out project (used by bash redirect/overwrite checks and the write guard) */
export function matchesProtectedPath(absolutePath: string): boolean {
	const segments = normalize(absolutePath).toLowerCase().split(sep);

	for (const pattern of PROTECTED_PATH_PATTERNS) {
		const pat = pattern.toLowerCase();
		const isDir = pat.endsWith("/");
		const core = isDir ? pat.slice(0, -1) : pat;

		// Suffix patterns (*.pem, *.key): match any path segment
		if (core.startsWith("*.")) {
			const suffix = core.slice(1);
			if (segments.some((seg) => seg.endsWith(suffix))) return true;
			continue;
		}

		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i];
			if (seg === core) {
				// Dir patterns (.git/, node_modules/, etc.) match any directory segment;
				// file patterns (.env) only match the last segment
				if (isDir || i === segments.length - 1) return true;
			}
			// File-pattern variants (.env.local / .env.production, last segment)
			if (!isDir && i === segments.length - 1 && seg.startsWith(core + ".")) {
				// key files: exact name only, never a `.pub`/backup variant
				if (EXACT_ONLY_PATTERNS.has(core)) continue;
				// credentials: allow clearly non-secret template/example variants
				if (core === "credentials") {
					const ext = seg.slice(core.length);
					if (SAFE_CREDENTIAL_SUFFIXES.has(ext)) continue;
				}
				return true;
			}
		}
	}
	return false;
}

/**
 * Dangerous command classification:
 *   - "block"   → system-destructive (format/shutdown/bulk-delete/block-device writes), blocked in every mode
 *   - "confirm" → privilege/remote/risky (sudo/ssh/chmod 777), blocked in strict, confirmed otherwise
 *   - null      → not dangerous
 */

/** Expand ~ / ~/xxx to HOME */
export function expandHome(p: string): string {
	if (p === "~") return HOME;
	if (p.startsWith("~/")) return join(HOME, p.slice(2));
	// Foreign home (~user/...) can't be resolved statically and must never be
	// mistaken for an in-project relative path. Anchor it at the filesystem root
	// so the outside-project rules apply (conservative confirm / block instead
	// of a silent in-project pass).
	if (p.startsWith("~")) return "/" + p;
	return p;
}

/** Whether a path token carries shell variable/glob syntax that can't be statically resolved */

/** Whether a path token carries shell variable/glob syntax that can't be statically resolved */
export function isUnresolvedTarget(p: string): boolean {
	return p.includes("$") || p.includes("*") || p.includes("?");
}

/**
 * Whether a command operand is an rsync/scp-style remote target
 * (`user@host:/path`, `host:/path`, `user@host::module`, `rsync://host/path`).
 * Remote targets must never be resolved as local (in-project) paths.
 */

/**
 * Whether a command operand is an rsync/scp-style remote target
 * (`user@host:/path`, `host:/path`, `user@host::module`, `rsync://host/path`).
 * Remote targets must never be resolved as local (in-project) paths.
 */
export function isRemoteTarget(p: string): boolean {
	if (p.startsWith("rsync://")) return true;
	// user@host:path (also git@github.com:owner/repo)
	if (/^[^/@:\s]+@[^/:\s]+:/.test(p)) return true;
	// host:path (no user, and not a local path like /foo or ./bar)
	if (/^[^/@:\s]+:/.test(p)) return true;
	return false;
}

/** Redirect target: { op, target }; null if none */

/** Whether the path is a directory */
export function isDirectory(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Resolve symlinks to the real path.
 * For missing paths, walk upward from the nearest existing ancestor, resolve the first
 * resolvable parent, and append the remainder. Unlike top-down resolution, this correctly
 * handles mid-path symlinks (e.g. in-project lnk -> external dir), preventing deep missing
 * paths from being written through a symlink to outside the project; also handles symlink cwd.
 */

/**
 * Resolve symlinks to the real path.
 * For missing paths, walk upward from the nearest existing ancestor, resolve the first
 * resolvable parent, and append the remainder. Unlike top-down resolution, this correctly
 * handles mid-path symlinks (e.g. in-project lnk -> external dir), preventing deep missing
 * paths from being written through a symlink to outside the project; also handles symlink cwd.
 */
export function resolveReal(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		let cur = p;
		const tail: string[] = [];
		for (;;) {
			const parent = dirname(cur);
			if (parent === cur) break; // reached root; path doesn't exist at all
			try {
				const real = realpathSync(parent);
				return join(real, basename(cur), ...tail);
			} catch {
				tail.unshift(basename(cur));
				cur = parent;
			}
		}
		return normalize(p);
	}
}

