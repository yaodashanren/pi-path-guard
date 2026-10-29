// path-guard — guard modes, tunable rules, user path lists, and settings
// persistence. All mutable guard state lives in this module.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { HOME, CONFIG_DIR } from "./constants.ts";
import { tagged } from "./escape.ts";
import { expandHome, isOutsideCwd, matchesProtectedPath, resolveReal } from "./paths.ts";


import type { GuardMode, RuleId, RuleLevel } from "./schema.ts";
import { DEFAULT_MODES, GUARD_MODES, RULE_IDS, isGuardMode, isRuleLevel } from "./schema.ts";

// Re-export the schema so every existing importer keeps working unchanged.
export * from "./schema.ts";

/** Current session guard mode (switched via /guard; reset to normal on session_start) */
let currentMode: GuardMode = "normal";
/** Effective rule level for the current mode (settings override ?? built-in default). */
export function rl(rule: RuleId): RuleLevel {
	// A confirm dialog's "Allow & set … = pass (session)" outranks config/defaults
	// for the rest of this session (never persisted).
	if (isSessionPassed(currentMode, rule)) return "pass";
	return config.rules[currentMode]?.[rule] ?? DEFAULT_MODES[currentMode][rule];
}

/** Effective rule level for a specific mode (override ?? built-in default). */
export function rlFor(mode: GuardMode, rule: RuleId): RuleLevel {
	return config.rules[mode]?.[rule] ?? DEFAULT_MODES[mode][rule];
}

/** Map a rule to a segment verdict: block (with reason) / confirm / pass. */
export function ruleVerdict(rule: RuleId, blockReason: string): SegmentVerdict {
	const lvl = rl(rule);
	if (lvl === "block")
		return {
			kind: "block",
			reason: tagged(
				rule === "blockGroup" ? "systemDestructive" : "rule",
				blockReason,
			),
		};
	if (lvl === "confirm") return { kind: "confirm", rules: [rule] };
	return { kind: "pass" };
}

/** Whether the current mode is naked (many conservative confirms become pass). */
export const inNaked = () => currentMode === "naked";

/**
 * User-configured protected paths (pathGuard.extraProtected). Unlike built-in
 * protected paths, these are enforced in EVERY mode — including naked.
 */
let extraProtected: string[] = [];

/** Match a resolved absolute path against a user-configured protected entry. */
export function isUserProtectedPath(absolutePath: string): boolean {
	for (const entry of extraProtected) {
		const e = normalize(resolveReal(entry));
		if (absolutePath === e) return true;
		if (absolutePath.startsWith(e + sep)) return true;
	}
	return false;
}

/** Expand ~ and resolve relative entries against cwd into a canonical absolute path.
 * Deliberately does NOT resolve symlinks: protection/trust is anchored to the literal
 * path the user configured, so it keeps guarding that location even when a symlink in
 * it is created/removed/retargeted later (across sessions or during builds). At match
 * time (isUserProtectedPath / isTrustedPath) the entry's CURRENT real path is resolved,
 * so writes through a symlink to the same real target are still caught — but a write to
 * the literal path is never missed because the stored entry drifted to an old target. */
export function normalizeProtectedEntry(
	entry: string,
	cwd: string | undefined,
): string {
	const expanded = expandHome(entry.trim());
	// resolve() normalizes (absolute, dot-segment-free) but does NOT follow symlinks.
	return resolve(cwd ?? HOME, expanded);
}

/**
 * User-configured trusted paths (pathGuard.trustedPaths). Operations whose target
 * lies inside a trusted path are always allowed — path-guard treats them as if the
 * active mode were "trusted" for just that path, regardless of the current mode:
 * writes/edits/deletes/overwrites/truncates/in-place edits inside it pass without
 * prompting. Protection always outranks trust: a trusted path can never be a
 * protected path (built-in system path or user-protected path), so those stay blocked.
 */
let trustedPaths: string[] = [];

/** Path category selector used by both the CLI and interactive /guard paths UIs. */
export type PathKind = "protected" | "trusted";

/** The live entry list for a path category. */
export function pathList(kind: PathKind): string[] {
	return kind === "trusted" ? trustedPaths : extraProtected;
}

/** Whether a path is a user-configured trusted entry (or under one). */
export function isTrustedPath(absolutePath: string): boolean {
	for (const entry of trustedPaths) {
		const e = normalize(resolveReal(entry));
		if (absolutePath === e) return true;
		if (absolutePath.startsWith(e + sep)) return true;
	}
	return false;
}

/**
 * Why a path cannot be added as a trusted entry, or null if it can be trusted.
 * Trusting never overrides protection, so built-in system paths and user-protected
 * paths (or anything under them) are refused.
 */
export function untrustableReason(absolutePath: string): string | null {
	// Compare on the REAL path so a literal entry that goes through a symlink into a
	// protected location is still refused as trusted.
	const real = resolveReal(absolutePath);
	if (isUserProtectedPath(real)) {
		return "it is a user-protected path — remove it from protected paths first";
	}
	if (matchesProtectedPath(real)) {
		return "it is a system-important protected path (.env/.ssh/keys/credentials/node_modules/build-output) and cannot be trusted";
	}
	return null;
}

/** Guard verdict: { block, reason } to block / undefined to allow (askConfirm returns a Promise) */
export type GuardVerdict =
	| ToolCallEventResult
	| undefined
	| Promise<ToolCallEventResult | undefined>;

// ─── Entry ────────────────────────────────────────────────────────────

/** Set the current guard mode and mirror it into the TUI footer status bar. */
export function setMode(mode: GuardMode, ui: ExtensionUIContext) {
	currentMode = mode;
	refreshModeStatus(ui);
}

/**
 * Show the active guard mode in the footer status bar (persists across renders).
 * naked is highlighted in warning color so the "bare" state is unmissable.
 */
export function refreshModeStatus(ui: ExtensionUIContext) {
	const t = ui.theme;
	const color = currentMode === "naked" ? "warning" : "accent";
	const label = currentMode === "naked" ? "🛡 NAKED" : `🛡 ${currentMode}`;
	ui.setStatus("path-guard", t.fg(color, label));
}

// ─── Settings persistence (mode survives across sessions) ─────────────

/** Global settings.json path (~/.pi/agent/settings.json; PI_PATH_GUARD_SETTINGS overrides, for tests).
 * The agent dir itself follows pi's PI_CODING_AGENT_DIR override (default ~/.pi/agent). */
export function globalSettingsPath(): string {
	return (
		process.env.PI_PATH_GUARD_SETTINGS ??
		join(
			process.env.PI_CODING_AGENT_DIR ?? join(HOME, ".pi", "agent"),
			"settings.json",
		)
	);
}

/** Whether cwd is the user's HOME (never treated as a project for settings). */
export function isHomeCwd(cwd: string | undefined): boolean {
	if (!cwd) return false;
	return resolveReal(cwd) === resolveReal(HOME);
}

/** Project settings.json path (cwd/.pi/settings.json), or undefined when no cwd. */
export function projectSettingsPath(cwd: string | undefined): string | undefined {
	return cwd ? join(cwd, CONFIG_DIR, "settings.json") : undefined;
}

/**
 * Loaded path-guard config: active mode, user-configured protected paths, and
 * per-mode rule overrides. Repopulated from settings.json on every session_start.
 */
export interface PathGuardConfig {
	mode: GuardMode;
	extraProtected: string[];
	trustedPaths: string[];
	rules: Partial<Record<GuardMode, Partial<Record<RuleId, RuleLevel>>>>;
}

let config: PathGuardConfig = {
	mode: "normal",
	extraProtected: [],
	trustedPaths: [],
	rules: {},
};

/**
 * Session-only rule passes set from a confirm dialog's "Allow & set … = pass
 * (session)" option. Kept separate from `config.rules` so that a later
 * persistConfig (e.g. /guard rules) can never write them to disk — a new session
 * reverts to the configured / built-in levels.
 */
const sessionPass: Partial<Record<GuardMode, Set<RuleId>>> = {};

/** Whether a rule was session-passed from a confirm dialog. */
export function isSessionPassed(mode: GuardMode, rule: RuleId): boolean {
	return sessionPass[mode]?.has(rule) ?? false;
}

/** Session-pass one or more rules for a mode (in-memory only, never persisted). */
export function sessionPassRule(mode: GuardMode, rule: RuleId): void {
	(sessionPass[mode] ??= new Set()).add(rule);
}

/** Drop session-pass overrides (one mode, or all) — used when rules are edited. */
export function clearSessionPass(mode?: GuardMode): void {
	if (mode) {
		delete sessionPass[mode];
		return;
	}
	for (const m of GUARD_MODES) delete sessionPass[m];
}

/** Read and validate the raw pathGuard block from a settings.json file, or undefined. */
export function readSettingsGuard(
	filePath: string | undefined,
): Partial<PathGuardConfig> | undefined {
	if (!filePath) return undefined;
	try {
		if (!existsSync(filePath)) return undefined;
		const data = JSON.parse(readFileSync(filePath, "utf8")) as {
			pathGuard?: {
				mode?: string;
				extraProtected?: string[];
				trustedPaths?: string[];
				rules?: Record<string, Record<string, string>>;
			};
		};
		const g = data?.pathGuard;
		if (!g) return undefined;
		const out: Partial<PathGuardConfig> = {};
		if (typeof g.mode === "string" && isGuardMode(g.mode)) out.mode = g.mode;
		if (Array.isArray(g.extraProtected)) {
			out.extraProtected = g.extraProtected.filter(
				(p): p is string => typeof p === "string",
			);
		}
		if (Array.isArray(g.trustedPaths)) {
			out.trustedPaths = g.trustedPaths.filter(
				(p): p is string => typeof p === "string",
			);
		}
		if (g.rules && typeof g.rules === "object") {
			const rules: PathGuardConfig["rules"] = {};
			for (const [m, overrides] of Object.entries(g.rules)) {
				if (!isGuardMode(m) || !overrides || typeof overrides !== "object")
					continue;
				const clean: Partial<Record<RuleId, RuleLevel>> = {};
				for (const [r, lvl] of Object.entries(overrides)) {
					if ((RULE_IDS as readonly string[]).includes(r) && isRuleLevel(lvl)) {
						clean[r as RuleId] = lvl;
					}
				}
				if (Object.keys(clean).length > 0) rules[m] = clean;
			}
			if (Object.keys(rules).length > 0) out.rules = rules;
		}
		return out;
	} catch {
		return undefined;
	}
}

/**
 * Effective config at session start. The active mode/extraProtected/rules are
 * persisted to the GLOBAL settings file only (~/.pi/agent/settings.json) and
 * restored from there — see persistConfig for why project-scoped writes are
 * avoided. A trusted project's .pi/settings.json may still OPT-IN override the
 * global mode (read-side only, for hand-authored project config); since path-guard
 * itself never writes that file, using /guard can no longer turn a plain project
 * into a "trust-requiring" one (which is what made pi start asking for trust and
 * silently drop a saved mode on untrusted launches).
 */
export function readSavedConfig(
	cwd: string | undefined,
	trusted: boolean,
): PathGuardConfig {
	const global = readSettingsGuard(globalSettingsPath()) ?? {};
	const project =
		trusted && !isHomeCwd(cwd)
			? (readSettingsGuard(projectSettingsPath(cwd)) ?? {})
			: {};
	const mode = project.mode ?? global.mode ?? "normal";
	const extraProtected = [
		...(global.extraProtected ?? []),
		...(project.extraProtected ?? []),
	].map((e) => normalizeProtectedEntry(e, cwd));
	const trustedPaths = [
		...(global.trustedPaths ?? []),
		...(project.trustedPaths ?? []),
	].map((e) => normalizeProtectedEntry(e, cwd));
	const rules = { ...global.rules, ...project.rules };
	return { mode, extraProtected, trustedPaths, rules };
}

/**
 * Persist the whole config to the GLOBAL settings file (~/.pi/agent/settings.json),
 * regardless of cwd or project trust. Project-scoped writes are deliberately avoided:
 * writing cwd/.pi/settings.json would make that project "trust-requiring", so pi would
 * begin asking for trust on the next launch (defaultProjectTrust=ask) and a declined/
 * untrusted launch would silently ignore the saved mode — the flapping that made a
 * saved mode revert to normal. Global settings are never trust-gated, so the mode the
 * user sets always survives. Returns "global" on success, "none" when there is no cwd.
 */
/** Reason the last persistConfig call fell back to session-only (empty on success). */
let lastPersistError = "";

export function persistConfig(cwd: string | undefined): string {
	if (!cwd) return "none";
	const target = globalSettingsPath();
	try {
		let data: Record<string, unknown> = {};
		if (existsSync(target)) {
			data = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
		}
		const guard = (data.pathGuard as Record<string, unknown>) ?? {};
		guard.mode = config.mode;
		if (extraProtected.length > 0) {
			guard.extraProtected = extraProtected;
		} else {
			delete guard.extraProtected;
		}
		if (trustedPaths.length > 0) {
			guard.trustedPaths = trustedPaths;
		} else {
			delete guard.trustedPaths;
		}
		if (Object.keys(config.rules).length > 0) {
			guard.rules = config.rules;
		} else {
			delete guard.rules;
		}
		data.pathGuard = guard;
		writeFileSync(target, JSON.stringify(data, null, 2) + "\n", "utf8");
		lastPersistError = "";
		return "global";
	} catch (e) {
		lastPersistError = e instanceof Error ? e.message : String(e);
		return "none";
	}
}

/** Human-readable persistence note for notify messages. */
export function persistNote(where: string): string {
	if (where === "global") return "saved to global settings";
	return lastPersistError
		? `session-only — could not write global settings: ${lastPersistError}`
		: "session-only (not persisted)";
}

/** Apply a loaded/saved config wholesale (session_start restore). */
export function applyConfig(saved: PathGuardConfig): void {
	config = saved;
	extraProtected = saved.extraProtected;
	trustedPaths = saved.trustedPaths;
}

/** Live config accessor (rule overrides / mode are mutated in place). */
export function getConfig(): PathGuardConfig {
	return config;
}

/** Current active guard mode. */
export function getMode(): GuardMode {
	return currentMode;
}

/** Copy of the session-passed rules for a mode (for display). */
export function sessionPassList(mode: GuardMode): RuleId[] {
	return [...(sessionPass[mode] ?? [])];
}

/**
 * Tunable rules never offered the confirm dialog's session-pass shortcut:
 * `confirmGroup` (sudo/ssh/chmod 777) and `blockGroup` (system-destructive).
 */
export const SESSION_PASS_EXCLUDED = new Set<RuleId>(["confirmGroup", "blockGroup"]);
