// path-guard — config storage layer: agent/projects directory locations,
// project entry file encoding, structured settings reads, layer merging and
// atomic writes. No module state and no judgement logic live here, so this
// module is safe to import from rules.ts and from tests.
import {
	closeSync,
	existsSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { HOME } from "./constants.ts";
import { resolveReal } from "./paths.ts";
import type {
	ConfigWarning,
	GuardMode,
	LayerRead,
	PathGuardLayer,
	ProjectLookup,
	RuleId,
	RuleLevel,
	SettingsRead,
} from "./schema.ts";
import { GUARD_MODES, RULE_IDS, isGuardMode, isRuleLevel } from "./schema.ts";

/** pi agent directory: PI_CODING_AGENT_DIR override, else ~/.pi/agent. */
export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(HOME, ".pi", "agent");
}

/**
 * Per-project config directory. PI_PATH_GUARD_PROJECTS_DIR replaces the whole
 * directory (tests use this); otherwise it lives under the pi agent dir.
 */
export function projectsDir(): string {
	return (
		process.env.PI_PATH_GUARD_PROJECTS_DIR ??
		join(agentDir(), "path-guard", "projects")
	);
}

function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * Write `data` to `filePath` atomically: same-directory temp file → fsync →
 * rename. Never creates parent directories — callers decide whether a missing
 * parent is an error (a missing agent dir must stay an error so /guard can warn
 * instead of silently creating directories). Keeps the existing file's mode.
 */
export function writeFileAtomic(
	filePath: string,
	data: string,
	mode?: number,
): void {
	const dir = dirname(filePath);
	let fileMode = mode ?? 0o600;
	if (mode === undefined && existsSync(filePath)) {
		try {
			fileMode = statSync(filePath).mode & 0o777;
		} catch {
			// keep the default when the mode cannot be read
		}
	}
	const tmp = join(
		dir,
		`.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`,
	);
	try {
		const fd = openSync(tmp, "wx", fileMode);
		try {
			writeSync(fd, data);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, filePath);
	} catch (e) {
		try {
			rmSync(tmp, { force: true });
		} catch {
			// nothing left to clean up
		}
		throw e;
	}
}

/** Validate a raw `pathGuard` block (or a project entry body) into a layer. */
export function validateLayer(
	raw: unknown,
	filePath: string,
	scope: "global" | "project",
): { layer: PathGuardLayer; warnings: ConfigWarning[] } {
	const warnings: ConfigWarning[] = [];
	const layer: PathGuardLayer = {};
	const warn = (field: string, message: string) =>
		warnings.push({ path: filePath, field, message });
	if (!raw || typeof raw !== "object") return { layer, warnings };
	const g = raw as Record<string, unknown>;

	if (g.mode !== undefined) {
		if (typeof g.mode === "string" && isGuardMode(g.mode)) {
			layer.mode = g.mode;
		} else {
			warn("mode", `unknown guard mode ${JSON.stringify(g.mode)}`);
		}
	}

	for (const key of ["extraProtected", "trustedPaths"] as const) {
		const value = g[key];
		if (value === undefined) continue;
		if (!Array.isArray(value)) {
			warn(key, `expected an array of paths`);
			continue;
		}
		const kept: string[] = [];
		value.forEach((entry, i) => {
			if (typeof entry !== "string" || entry.trim() === "") {
				warn(`${key}[${i}]`, `expected a non-empty path string`);
				return;
			}
			const trimmed = entry.trim();
			if (scope === "global" && !isAbsolute(trimmed) && !trimmed.startsWith("~/")) {
				warn(
					`${key}[${i}]`,
					`relative path ${JSON.stringify(trimmed)} is not applied in global config — use an absolute path or "~/…", or move it to a project config`,
				);
				return;
			}
			kept.push(trimmed);
		});
		if (kept.length > 0) layer[key] = kept;
	}

	if (g.rules !== undefined) {
		if (!g.rules || typeof g.rules !== "object" || Array.isArray(g.rules)) {
			warn("rules", "expected an object of per-mode rule overrides");
		} else {
			const rules: NonNullable<PathGuardLayer["rules"]> = {};
			for (const [mode, overrides] of Object.entries(
				g.rules as Record<string, unknown>,
			)) {
				if (!isGuardMode(mode)) {
					warn(`rules.${mode}`, `unknown guard mode`);
					continue;
				}
				if (!overrides || typeof overrides !== "object") {
					warn(`rules.${mode}`, "expected an object of rule levels");
					continue;
				}
				const clean: Partial<Record<RuleId, RuleLevel>> = {};
				for (const [rule, level] of Object.entries(
					overrides as Record<string, unknown>,
				)) {
					if (!(RULE_IDS as readonly string[]).includes(rule)) {
						warn(`rules.${mode}.${rule}`, "unknown rule id");
						continue;
					}
					if (typeof level !== "string" || !isRuleLevel(level)) {
						warn(
							`rules.${mode}.${rule}`,
							`unknown rule level ${JSON.stringify(level)}`,
						);
						continue;
					}
					clean[rule as RuleId] = level;
				}
				if (Object.keys(clean).length > 0) rules[mode as GuardMode] = clean;
			}
			if (Object.keys(rules).length > 0) layer.rules = rules;
		}
	}

	return { layer, warnings };
}

/** Read the `pathGuard` block of a settings.json file, never throwing. */
export function readSettingsFile(filePath: string | undefined): SettingsRead {
	if (!filePath) return { ok: true, guard: undefined, warnings: [] };
	if (!existsSync(filePath)) return { ok: true, guard: undefined, warnings: [] };
	let text: string;
	try {
		text = readFileSync(filePath, "utf8");
	} catch (e) {
		return { ok: false, reason: "io", path: filePath, message: errorText(e) };
	}
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch (e) {
		return { ok: false, reason: "json", path: filePath, message: errorText(e) };
	}
	const guard = (data as Record<string, unknown> | null)?.pathGuard;
	if (!guard || typeof guard !== "object") {
		return { ok: true, guard: undefined, warnings: [] };
	}
	const { layer, warnings } = validateLayer(guard, filePath, "global");
	return { ok: true, guard: layer, warnings };
}
