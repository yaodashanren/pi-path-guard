// path-guard — guard modes, tunable rules, user path lists, and settings
// persistence. All mutable guard state lives in this module.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { HOME, CONFIG_DIR } from "./constants.ts";
import { tagged } from "./escape.ts";
import { expandHome, isOutsideCwd, matchesProtectedPath, resolveReal } from "./paths.ts";

// ─── Guard Modes ─────────────────────────────────────────────────────

/** Guard mode: strict (full) / normal (default) / loose (relaxed) / trusted (most permissive) / naked (no protection) */
export type GuardMode = "strict" | "normal" | "loose" | "trusted" | "naked";

/** Current session guard mode (switched via /guard; reset to normal on session_start) */
let currentMode: GuardMode = "normal";

/** Valid guard modes */
export const GUARD_MODES: readonly GuardMode[] = [
	"strict",
	"normal",
	"loose",
	"trusted",
	"naked",
];

/** Whether a string is a valid guard mode (for /guard argument validation) */
export function isGuardMode(m: string): m is GuardMode {
	return (GUARD_MODES as readonly string[]).includes(m);
}

/** Mode descriptions (shown in the /guard interactive picker; English first, Chinese brief after) */
export const MODE_DESCRIPTIONS: Record<GuardMode, string> = {
	strict:
		"Strict: confirm in-project writes, block dangerous commands / 全防护：项目内写也询问，危险命令直接阻止",
	normal:
		"Normal: block system-destructive commands, confirm sudo/ssh / 默认：系统级破坏直接阻止，提权/远程询问",
	loose:
		"Loose: pass new-file writes & deletes, confirm overwrites / 放宽：新建/删除免问，覆盖需确认",
	trusted:
		"Trusted: pass overwrites & ordinary-file deletes / 最宽松：覆盖/删除普通文件也免问",
	naked:
		"Naked: pass everything except system-destructive cmds (confirmed) / 裸奔：除系统级破坏命令外全部放行（破坏命令弹窗询问）",
};

// ─── Tunable rules & user-configured protected paths ──────────────────

/** Decision level a rule can produce. */
export type RuleLevel = "block" | "confirm" | "pass";

/**
 * Tunable rule IDs — each is a single decision point in the judgement logic.
 * A rule's effective value for the current mode = settings override ?? default.
 */
export type RuleId =
	| "blockGroup" // system-destructive mkfs/reboot/dev-write/bulk-delete
	| "confirmGroup" // privilege/remote sudo/ssh/chmod777
	| "writeOutside" // write/edit targeting a path outside the project
	| "writeHome" // write/edit under HOME
	| "writeInProject" // write/edit creating/overwriting in the project
	| "deleteOutside" // rm outside the project
	| "deleteInProject" // rm in the project
	| "overwriteOutsideExisting" // mv/cp over an existing target outside
	| "overwriteOutsideNew" // mv/cp creating a target outside
	| "overwriteInProject" // mv/cp overwrite in the project
	| "truncateInProject" // `> existing in-project file` / truncate in project
	| "truncateOutside" // `> existing outside file` / truncate outside
	| "gitDestructive" // git clean -f / reset --hard / checkout . / push --force …
	| "pipeToShellInProject" // curl/wget/interpreter output piped into a shell (in-workspace)
	| "pipeToShellOutside" // … with a remote/outside-workspace source
	| "runScriptInProject" // source/./bash script.sh inside the project
	| "runScriptOutside" // … outside the project / under HOME
	| "runScriptProtected" // … targeting a built-in protected path
	| "scriptUnresolved" // … a `$VAR`/glob target that cannot be resolved statically
	| "redirectUnresolved" // … a `$VAR`/glob redirect target that cannot be resolved statically
	| "commandNameUnresolved"; // … the command NAME itself is `$VAR`/`$(…)` and cannot be resolved statically

export const RULE_IDS: readonly RuleId[] = [
	"blockGroup",
	"confirmGroup",
	"writeOutside",
	"writeHome",
	"writeInProject",
	"deleteOutside",
	"deleteInProject",
	"overwriteOutsideExisting",
	"overwriteOutsideNew",
	"overwriteInProject",
	"truncateInProject",
	"truncateOutside",
	"gitDestructive",
	"pipeToShellInProject",
	"pipeToShellOutside",
	"runScriptInProject",
	"runScriptOutside",
	"runScriptProtected",
	"scriptUnresolved",
	"redirectUnresolved",
	"commandNameUnresolved",
];

/** Bilingual short labels for each tunable rule (used in the rule-editor menu). */
export const RULE_DESCRIPTIONS: Record<RuleId, string> = {
	blockGroup: "system-destructive mkfs/reboot (系统级破坏)",
	confirmGroup: "privilege/remote sudo/ssh/chmod777 (权限/远程)",
	writeOutside: "write/edit outside project (项目外写)",
	writeHome: "write/edit under HOME (HOME 下写)",
	writeInProject: "write/edit in project (项目内写)",
	deleteOutside: "delete outside project (项目外删)",
	deleteInProject: "delete in project (项目内删)",
	overwriteOutsideExisting: "overwrite existing outside (项目外覆盖已存在)",
	overwriteOutsideNew: "create target outside (项目外新建)",
	overwriteInProject: "overwrite in project (项目内覆盖)",
	truncateInProject: "truncate existing in-project file (截断项目内已存在文件)",
	truncateOutside: "truncate existing outside file (截断项目外已存在文件)",
	gitDestructive: "git destructive reset --hard (Git 破坏性)",
	pipeToShellInProject: "pipe to shell, in-project (管道进 shell·项目内)",
	pipeToShellOutside: "pipe to shell, remote/outside (管道进 shell·远程/外)",
	runScriptInProject: "source/./bash script, in-project (运行脚本·项目内)",
	runScriptOutside: "source/./bash script, outside/HOME (运行脚本·项目外/HOME)",
	runScriptProtected:
		"source/./bash script of a built-in protected path (运行脚本·内置保护)",
	scriptUnresolved:
		"source/./script with a $VAR/glob path that cannot be resolved (脚本路径不可静态解析)",
	redirectUnresolved:
		"redirect target with a $VAR/glob that cannot be resolved (重定向目标不可静态解析)",
	commandNameUnresolved:
		"command name itself is $VAR/$(…) and cannot be resolved (命令名不可静态解析)",
};

export const RULE_LEVELS: readonly RuleLevel[] = ["block", "confirm", "pass"];

export const RULE_LEVEL_LABELS: Record<RuleLevel, string> = {
	block: "block — Block (阻止)",
	confirm: "confirm — Confirm (确认)",
	pass: "pass — Pass (放行)",
};

export function isRuleLevel(v: string | undefined): v is RuleLevel {
	return v === "block" || v === "confirm" || v === "pass";
}

/** Default rules per built-in mode — reproduces the pre-config (v1.0.0) hardcoded behaviour exactly. */
export const DEFAULT_MODES: Record<GuardMode, Record<RuleId, RuleLevel>> = {
	strict: {
		blockGroup: "block",
		confirmGroup: "block",
		writeOutside: "confirm",
		writeHome: "confirm",
		writeInProject: "confirm",
		deleteOutside: "block",
		deleteInProject: "confirm",
		overwriteOutsideExisting: "block",
		overwriteOutsideNew: "confirm",
		overwriteInProject: "confirm",
		truncateInProject: "confirm",
		truncateOutside: "block",
		gitDestructive: "confirm",
		pipeToShellInProject: "confirm",
		pipeToShellOutside: "confirm",
		runScriptInProject: "confirm",
		runScriptOutside: "block",
		runScriptProtected: "block",
		scriptUnresolved: "block",
		redirectUnresolved: "block",
		commandNameUnresolved: "block",
	},
	normal: {
		blockGroup: "block",
		confirmGroup: "confirm",
		writeOutside: "confirm",
		writeHome: "confirm",
		writeInProject: "pass",
		deleteOutside: "block",
		deleteInProject: "confirm",
		overwriteOutsideExisting: "block",
		overwriteOutsideNew: "confirm",
		overwriteInProject: "confirm",
		truncateInProject: "confirm",
		truncateOutside: "confirm",
		gitDestructive: "confirm",
		pipeToShellInProject: "pass",
		pipeToShellOutside: "confirm",
		runScriptInProject: "confirm",
		runScriptOutside: "confirm",
		runScriptProtected: "confirm",
		scriptUnresolved: "confirm",
		redirectUnresolved: "confirm",
		commandNameUnresolved: "confirm",
	},
	loose: {
		blockGroup: "block",
		confirmGroup: "confirm",
		writeOutside: "pass",
		writeHome: "pass",
		writeInProject: "pass",
		deleteOutside: "confirm",
		deleteInProject: "pass",
		overwriteOutsideExisting: "confirm",
		overwriteOutsideNew: "pass",
		overwriteInProject: "confirm",
		truncateInProject: "pass",
		truncateOutside: "confirm",
		gitDestructive: "confirm",
		pipeToShellInProject: "pass",
		pipeToShellOutside: "pass",
		runScriptInProject: "pass",
		runScriptOutside: "confirm",
		runScriptProtected: "confirm",
		scriptUnresolved: "confirm",
		redirectUnresolved: "confirm",
		commandNameUnresolved: "confirm",
	},
	trusted: {
		blockGroup: "block",
		confirmGroup: "confirm",
		writeOutside: "pass",
		writeHome: "pass",
		writeInProject: "pass",
		deleteOutside: "pass",
		deleteInProject: "pass",
		overwriteOutsideExisting: "pass",
		overwriteOutsideNew: "pass",
		overwriteInProject: "pass",
		truncateInProject: "pass",
		truncateOutside: "pass",
		gitDestructive: "confirm",
		pipeToShellInProject: "pass",
		pipeToShellOutside: "pass",
		runScriptInProject: "pass",
		runScriptOutside: "pass",
		runScriptProtected: "pass",
		scriptUnresolved: "pass",
		redirectUnresolved: "pass",
		commandNameUnresolved: "pass",
	},
	naked: {
		blockGroup: "confirm",
		confirmGroup: "pass",
		writeOutside: "pass",
		writeHome: "pass",
		writeInProject: "pass",
		deleteOutside: "pass",
		deleteInProject: "pass",
		overwriteOutsideExisting: "pass",
		overwriteOutsideNew: "pass",
		overwriteInProject: "pass",
		truncateInProject: "pass",
		truncateOutside: "pass",
		gitDestructive: "pass",
		pipeToShellInProject: "pass",
		pipeToShellOutside: "pass",
		runScriptInProject: "pass",
		runScriptOutside: "pass",
		runScriptProtected: "pass",
		scriptUnresolved: "pass",
		redirectUnresolved: "pass",
		commandNameUnresolved: "pass",
	},
};

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
	if (lvl === "confirm") return { kind: "confirm", rule };
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

/** Tunable rules never offered the confirm dialog's session-pass shortcut. */
export const SESSION_PASS_EXCLUDED = new Set<RuleId>(["confirmGroup", "blockGroup"]);
