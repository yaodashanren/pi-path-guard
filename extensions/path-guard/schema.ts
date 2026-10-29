// path-guard — guard schema: modes, tunable rule ids/levels, bilingual
// labels and the built-in per-mode defaults. Pure data and type guards only:
// no I/O, no module state, no imports. rules.ts re-exports all of it.

// ─── Guard Modes ─────────────────────────────────────────────────────

/** Guard mode: strict (full) / normal (default) / loose (relaxed) / trusted (most permissive) / naked (no protection) */
export type GuardMode = "strict" | "normal" | "loose" | "trusted" | "naked";

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
	| "archiveExtract" // unzip / tar -x: archive contents unknowable, may overwrite anything
	| "targetUnresolved" // mv/cp/dd/curl/… write target is a $VAR/glob, not statically resolvable
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
	"archiveExtract",
	"targetUnresolved",
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
	archiveExtract:
		"unzip / tar -x archive extraction, contents unknowable (解压归档·内容不可知)",
	targetUnresolved:
		"write target is a $VAR/glob that cannot be resolved (写目标不可静态解析)",
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
		archiveExtract: "confirm",
	targetUnresolved: "confirm",
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
		archiveExtract: "confirm",
	targetUnresolved: "confirm",
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
		archiveExtract: "confirm",
	targetUnresolved: "confirm",
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
		archiveExtract: "pass",
	targetUnresolved: "pass",
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
		archiveExtract: "pass",
	targetUnresolved: "pass",
		commandNameUnresolved: "pass",
},
};

// ─── Config layers (global settings / per-project entry files) ───────

/** Per-mode rule overrides: mode → rule → level. */
export type RulesLayer = Partial<Record<GuardMode, Partial<Record<RuleId, RuleLevel>>>>;

/**
 * One config layer as stored on disk. Every field is optional: a missing field
 * means "inherit from the layer below" (global settings, then built-in defaults).
 */
export interface PathGuardLayer {
	mode?: GuardMode;
	extraProtected?: string[];
	trustedPaths?: string[];
	rules?: RulesLayer;
}

/** A field-level config problem, surfaced instead of silently ignored. */
export interface ConfigWarning {
	path: string;
	field?: string;
	message: string;
}

/** Result of reading a settings.json file: never throws, always explains. */
export type SettingsRead =
	| { ok: true; guard: PathGuardLayer | undefined; warnings: ConfigWarning[] }
	| { ok: false; reason: "json" | "io"; path: string; message: string };

/** Result of reading one project entry file. */
export type LayerRead =
	| { ok: true; layer: PathGuardLayer; project: string; warnings: ConfigWarning[] }
	| { ok: false; reason: "json" | "io" | "mismatch"; path: string; message: string };

/** The project config that applies to a working directory. */
export interface ProjectLookup {
	filePath: string;
	projectRoot: string;
	matchedVia: "exact" | "ancestor";
	layer: PathGuardLayer;
	warnings: ConfigWarning[];
}

/** Lookup result: the match (if any) plus problems met while searching. */
export interface ProjectLookupResult {
	lookup?: ProjectLookup;
	warnings: ConfigWarning[];
}

/** Which config layer an edit is written to. */
export type ConfigScope = "global" | "project";

/** Result of a persist attempt: the layer written and, when known, the file. */
export interface PersistWhere {
	kind: "global" | "project" | "none";
	file?: string;
}
