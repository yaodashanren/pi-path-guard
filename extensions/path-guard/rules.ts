// path-guard — guard modes, tunable rules, user path lists, and settings
// persistence. All mutable guard state lives in this module.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { HOME, CONFIG_DIR } from "./constants.ts";
import type {
	ExtensionUIContext,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import type { SegmentVerdict } from "./judges.ts";
import { tagged } from "./escape.ts";
import { expandHome, isOutsideCwd, matchesProtectedPath, resolveReal } from "./paths.ts";
import {
	findProjectConfig,
	mergeLayers,
	projectEntryPath,
	readProjectEntry,
	readSettingsFile,
	writeFileAtomic,
} from "./store.ts";


import type {
	ConfigScope,
	ConfigWarning,
	GuardMode,
	PathGuardLayer,
	PersistWhere,
	ProjectLookup,
	RuleId,
	RuleLevel,
} from "./schema.ts";
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

/** Which layer currently supplies the effective value for a (mode, rule) pair. */
export type RuleProvenance = "session-pass" | "project" | "global" | "default";

/**
 * Which layer currently supplies the effective value for (mode, rule).
 * Precedence mirrors rl(): session-pass > project > global > default. Pure
 * lookup over the raw layers — the merged `config.rules` cannot answer this.
 *
 * A hand-authored `cwd/.pi/settings.json` block reports as "global": it is the
 * fallback overlay only when no project entry matched (same rule as
 * rebuildEffective/mergeLayers), so once a project layer exists the authored
 * rules no longer contribute to rl() and must not claim provenance here.
 */
export function ruleProvenance(mode: GuardMode, rule: RuleId): RuleProvenance {
	if (isSessionPassed(mode, rule)) return "session-pass";
	const { global: globalLayer, project, authored } = getLayers();
	if (project?.rules?.[mode]?.[rule] !== undefined) return "project";
	if (globalLayer?.rules?.[mode]?.[rule] !== undefined) return "global";
	if (!project && authored?.layer.rules?.[mode]?.[rule] !== undefined)
		return "global";
	return "default";
}

/**
 * Suffix rendered after the level in rule labels: `(${level}${suffix})`.
 * default → "", global → " [global]", project → " [project]",
 * session-pass → ", session-pass".
 */
export function provenanceSuffix(mode: GuardMode, rule: RuleId): string {
	switch (ruleProvenance(mode, rule)) {
		case "project":
			return " [project]";
		case "global":
			return " [global]";
		case "session-pass":
			return ", session-pass";
		default:
			return "";
	}
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


/** Match a resolved absolute path against a user-configured protected entry. */
export function isUserProtectedPath(absolutePath: string): boolean {
	for (const entry of config.extraProtected) {
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


/** Path category selector used by both the CLI and interactive /guard paths UIs. */
export type PathKind = "protected" | "trusted";

/** The live entry list for a path category. */
export function pathList(kind: PathKind): string[] {
	return kind === "trusted" ? config.trustedPaths : config.extraProtected;
}

/** Effective path entries with provenance (which layer/file supplied each path). */
export function pathEntries(kind: PathKind): ScopedPathEntry[] {
	return [...scopedPaths[kind]];
}

/** Whether a path is a user-configured trusted entry (or under one). */
export function isTrustedPath(absolutePath: string): boolean {
	for (const entry of config.trustedPaths) {
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

/** Which layer a config value came from. */
export type PathLayerName = "global" | "project" | "authored";

/** One configured path plus its provenance (which layer/file supplied it). */
export interface ScopedPathEntry {
	raw: string;
	normalized: string;
	layer: PathLayerName;
	file: string;
}

/** A hand-authored `cwd/.pi/settings.json` pathGuard block (read-only compat layer). */
export interface AuthoredLayer {
	layer: PathGuardLayer;
	file: string;
	root: string;
}

/** Everything read at session_start: the raw layers, their provenance, and problems. */
export interface LoadedConfig {
	global: PathGuardLayer;
	project?: ProjectLookup;
	authored?: AuthoredLayer;
	warnings: ConfigWarning[];
}

/** Raw layers as stored on disk. The effective config is derived from these. */
let layers: {
	global: PathGuardLayer;
	project?: PathGuardLayer;
	authored?: AuthoredLayer;
	projectRoot?: string;
	projectFile?: string;
	matchedVia?: "exact" | "ancestor";
} = { global: {} };

/** Effective path entries with provenance (drives pathEntries). */
let scopedPaths: { protected: ScopedPathEntry[]; trusted: ScopedPathEntry[] } = {
	protected: [],
	trusted: [],
};

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
/**
 * Config problems from the last read (bad JSON, unknown fields, dropped relative
 * paths). Empty when everything was clean. Surfaced at session_start and by the
 * project view instead of silently falling back to built-in defaults.
 */
let configWarnings: ConfigWarning[] = [];

/** Config warnings collected during the most recent session_start read. */
export function getConfigWarnings(): ConfigWarning[] {
	return [...configWarnings];
}

function recordReadFailure(filePath: string, message: string): void {
	configWarnings.push({ path: filePath, message });
}

/** Read and validate the raw pathGuard block from a settings.json file. */
export function readSettingsGuard(
	filePath: string | undefined,
): PathGuardLayer | undefined {
	const read = readSettingsFile(filePath);
	if (!read.ok) {
		recordReadFailure(read.path, read.message);
		return undefined;
	}
	configWarnings.push(...read.warnings);
	return read.guard;
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
): LoadedConfig {
	configWarnings = [];
	const global = readSettingsGuard(globalSettingsPath()) ?? {};
	const found = findProjectConfig(cwd);
	configWarnings.push(...found.warnings);
	let authored: AuthoredLayer | undefined;
	if (trusted && cwd && !isHomeCwd(cwd)) {
		const file = projectSettingsPath(cwd) as string;
		const read = readSettingsFile(file);
		if (!read.ok) {
			configWarnings.push({ path: read.path, message: read.message });
		} else if (read.guard) {
			configWarnings.push(...read.warnings);
			authored = { layer: read.guard, file, root: resolveReal(cwd) };
		}
	}
	return { global, project: found.lookup, authored, warnings: [...configWarnings] };
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
let lastPersistPath = "";

/** Which layer /guard edits are saved to (session-only; never persisted). */
let writeScope: ConfigScope = "global";

/** Where edits are currently saved ("global" unless /guard --project was used). */
export function getWriteScope(): ConfigScope {
	return writeScope;
}

/** Choose the layer edits are saved to (per-command, session-only). */
export function setWriteScope(scope: ConfigScope): void {
	writeScope = scope;
}

function layerOf(scope: ConfigScope): PathGuardLayer | undefined {
	return scope === "global" ? layers.global : layers.project;
}

/** Base directory a layer's relative path entries resolve against. */
function baseOf(scope: ConfigScope): string {
	return scope === "global" ? HOME : (layers.projectRoot ?? HOME);
}

/**
 * Normalize a user-typed path exactly the way the given layer will store and
 * resolve it — UI messages and trust checks must use this, not the session cwd.
 */
export function normalizeInScope(scope: ConfigScope, entry: string): string {
	return normalizeProtectedEntry(entry, baseOf(scope));
}

/**
 * Persist ONLY the given layer. Global → the pathGuard block of
 * ~/.pi/agent/settings.json (all other keys preserved); project → that project's
 * entry file. The effective (merged) config is never written back, so an
 * inherited project value can no longer be frozen into the global file.
 */
export function persistConfig(
	scope: ConfigScope,
	cwd: string | undefined,
): PersistWhere {
	if (!cwd) return { kind: "none" };
	return scope === "global" ? persistGlobal() : persistProject(cwd);
}

function persistGlobal(): PersistWhere {
	const target = globalSettingsPath();
	lastPersistPath = target;
	try {
		let data: Record<string, unknown> = {};
		if (existsSync(target)) {
			data = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
		}
		const guard = (data.pathGuard as Record<string, unknown>) ?? {};
		const layer = layers.global;
		if (layer.mode) guard.mode = layer.mode;
		else delete guard.mode;
		if (layer.extraProtected?.length)
			guard.extraProtected = layer.extraProtected;
		else delete guard.extraProtected;
		if (layer.trustedPaths?.length) guard.trustedPaths = layer.trustedPaths;
		else delete guard.trustedPaths;
		if (layer.rules && Object.keys(layer.rules).length) guard.rules = layer.rules;
		else delete guard.rules;
		data.pathGuard = guard;
		writeFileAtomic(target, `${JSON.stringify(data, null, 2)}\n`);
		lastPersistError = "";
		return { kind: "global", file: target };
	} catch (e) {
		lastPersistError = e instanceof Error ? e.message : String(e);
		return { kind: "none" };
	}
}

function persistProject(cwd: string): PersistWhere {
	const file = layers.projectFile;
	if (!layers.project || !file || !layers.projectRoot) {
		lastPersistPath = "";
		lastPersistError = `no project config for ${cwd} — create one with /guard --project <mode> first`;
		return { kind: "none" };
	}
	lastPersistPath = file;
	try {
		// Never clobber a file we cannot read: the user must see and decide.
		if (existsSync(file)) {
			const existing = readProjectEntry(file);
			if (!existing.ok) {
				lastPersistError = `refusing to overwrite ${file} — ${existing.message}`;
				return { kind: "none" };
			}
		}
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		// Keep unknown/forward-compatible keys from the file we are updating.
		let existingBody: Record<string, unknown> = {};
		if (existsSync(file)) {
			try {
				existingBody = JSON.parse(readFileSync(file, "utf8")) as Record<
					string,
					unknown
				>;
			} catch {
				existingBody = {};
			}
		}
		const body: Record<string, unknown> = { ...existingBody };
		body.version = 1;
		body.project = layers.projectRoot;
		body.updatedAt = new Date().toISOString();
		for (const key of [
			"mode",
			"extraProtected",
			"trustedPaths",
			"rules",
		] as const) {
			const value = layers.project[key];
			const empty =
				value === undefined ||
				(Array.isArray(value) && value.length === 0) ||
				(typeof value === "object" && !Array.isArray(value) &&
					Object.keys(value as object).length === 0);
			if (empty) delete body[key];
			else body[key] = value;
		}
		writeFileAtomic(file, `${JSON.stringify(body, null, 2)}\n`);
		lastPersistError = "";
		return { kind: "project", file };
	} catch (e) {
		lastPersistError = e instanceof Error ? e.message : String(e);
		return { kind: "none" };
	}
}

/** Human-readable persistence note for notify messages (always names the target). */
export function persistNote(where: PersistWhere): string {
	if (where.kind === "global")
		return `saved to global settings (${where.file ?? globalSettingsPath()})`;
	if (where.kind === "project")
		return `saved to project config (${where.file ?? ""})`;
	if (lastPersistError) {
		return `session-only — could not write ${lastPersistPath || "config"}: ${lastPersistError}`;
	}
	return "session-only (not persisted)";
}

/** Switch the mode of one layer and persist just that layer. */
export function setModeIn(
	scope: ConfigScope,
	mode: GuardMode,
	cwd?: string,
): PersistWhere {
	const layer = layerOf(scope);
	if (!layer) return noLayer(scope, cwd);
	layer.mode = mode;
	rebuildEffective();
	return persistConfig(scope, cwd);
}

/** Set (or reset) one rule override in one layer. */
export function setRuleIn(
	scope: ConfigScope,
	mode: GuardMode,
	rule: RuleId,
	level: RuleLevel | "default",
	cwd?: string,
): PersistWhere {
	const layer = layerOf(scope);
	if (!layer) return noLayer(scope, cwd);
	const rules = (layer.rules ??= {});
	const overrides = (rules[mode] ??= {});
	if (level === "default") delete overrides[rule];
	else overrides[rule] = level;
	if (Object.keys(overrides).length === 0) delete rules[mode];
	if (Object.keys(rules).length === 0) delete layer.rules;
	clearSessionPass(mode);
	rebuildEffective();
	return persistConfig(scope, cwd);
}

/** Reset every override of one mode in one layer. */
export function resetModeIn(
	scope: ConfigScope,
	mode: GuardMode,
	cwd?: string,
): PersistWhere {
	const layer = layerOf(scope);
	if (!layer) return noLayer(scope, cwd);
	if (layer.rules) delete layer.rules[mode];
	if (layer.rules && Object.keys(layer.rules).length === 0) delete layer.rules;
	clearSessionPass(mode);
	rebuildEffective();
	return persistConfig(scope, cwd);
}

/** Clear every rule override in one layer. */
export function resetAllRulesIn(scope: ConfigScope, cwd?: string): PersistWhere {
	const layer = layerOf(scope);
	if (!layer) return noLayer(scope, cwd);
	delete layer.rules;
	clearSessionPass();
	rebuildEffective();
	return persistConfig(scope, cwd);
}

function noLayer(
	scope: ConfigScope,
	cwd: string | undefined,
): PersistWhere {
	lastPersistPath = "";
	lastPersistError =
		scope === "project"
			? `no project config for ${cwd ?? "this directory"} — create one with /guard --project <mode> first`
			: "no config layer";
	return { kind: "none" };
}

/** Add a path entry to one layer (stored as typed; normalized on read). */
export function addPathIn(
	scope: ConfigScope,
	kind: PathKind,
	rawInput: string,
	cwd?: string,
): { where: PersistWhere; error?: string; normalized?: string } {
	const layer = layerOf(scope);
	if (!layer) return { where: noLayer(scope, cwd) };
	const key = kind === "trusted" ? "trustedPaths" : "extraProtected";
	const list = (layer[key] ??= []);
	const raw = rawInput.trim();
	const base = baseOf(scope);
	const normalized = normalizeProtectedEntry(raw, base);
	if (list.some((entry) => normalizeProtectedEntry(entry, base) === normalized)) {
		return { where: { kind: "none" }, error: `already ${kind} — ${normalized}` };
	}
	list.push(raw);
	rebuildEffective();
	return { where: persistConfig(scope, cwd), normalized };
}

/** Remove a path entry from the layer that owns it (inherited entries cannot be). */
export function removePathIn(
	scope: ConfigScope,
	kind: PathKind,
	normalizedTarget: string,
	cwd?: string,
): { where?: PersistWhere; error?: string } {
	const layer = layerOf(scope);
	if (!layer) return { error: noLayer(scope, cwd).kind === "none" ? lastPersistError : "no layer" };
	const key = kind === "trusted" ? "trustedPaths" : "extraProtected";
	const base = baseOf(scope);
	const list = layer[key] ?? [];
	const idx = list.findIndex(
		(entry) => normalizeProtectedEntry(entry, base) === normalizedTarget,
	);
	if (idx === -1) {
		const other = scope === "project" ? layers.global : layers.authored?.layer;
		const inherited = (other?.[key] ?? []).some(
			(entry) =>
				normalizeProtectedEntry(entry, scope === "project" ? HOME : HOME) ===
				normalizedTarget,
		);
		return {
			error: inherited
				? `not removable here — ${normalizedTarget} is inherited from the ${scope === "project" ? "global" : "authored"} layer`
				: `not a ${kind} path in the ${scope} layer — ${normalizedTarget}`,
		};
	}
	list.splice(idx, 1);
	if (list.length === 0) delete layer[key];
	rebuildEffective();
	return { where: persistConfig(scope, cwd) };
}

/** Clear one path category in one layer. */
export function clearPathsIn(
	scope: ConfigScope,
	kind: PathKind,
	cwd?: string,
): { where?: PersistWhere; error?: string; cleared?: number; kept?: number } {
	const layer = layerOf(scope);
	if (!layer) return { error: "no config layer" };
	const key = kind === "trusted" ? "trustedPaths" : "extraProtected";
	const own = layer[key] ?? [];
	if (own.length === 0) {
		return { error: `no ${kind} paths in the ${scope} layer` };
	}
	delete layer[key];
	rebuildEffective();
	return {
		where: persistConfig(scope, cwd),
		cleared: own.length,
		kept: pathEntries(kind).length,
	};
}

/**
 * Make sure edits aimed at the project layer have a target. When a project entry
 * already applies (exact or ancestor match) it is used as-is — a subdirectory
 * session writes the ancestor's file rather than inventing a new one. Otherwise
 * an in-memory entry for `cwd` is created; it reaches disk on the next persist.
 */
export function ensureProjectLayer(
	cwd: string | undefined,
	mode?: GuardMode,
): { ok: boolean; error?: string } {
	if (!cwd || isHomeCwd(cwd)) {
		return {
			ok: false,
			error: "this directory has no project config (cwd is HOME) — staying global",
		};
	}
	// Always resolve from cwd: reusing whatever layer a previous session left in
	// memory could write to an unrelated project's file.
	const found = findProjectConfig(cwd);
	if (found.lookup) {
		layers.project = found.lookup.layer;
		layers.projectRoot = found.lookup.projectRoot;
		layers.projectFile = found.lookup.filePath;
		layers.matchedVia = found.lookup.matchedVia;
	} else {
		const root = resolveReal(cwd);
		const target = projectEntryPath(root);
		// An existing-but-unusable entry must never be silently overwritten: the
		// user gets to see the file and decide (fix it, or /guard project remove).
		if (existsSync(target)) {
			const broken = found.warnings[0];
			return {
				ok: false,
				error: `existing project entry ${target} cannot be used${broken ? ` — ${broken.message}` : ""}; fix it or delete it with /guard project remove`,
			};
		}
		layers.project = {};
		layers.projectRoot = root;
		layers.projectFile = target;
		layers.matchedVia = "exact";
	}
	if (mode) layers.project.mode = mode;
	rebuildEffective();
	return { ok: true };
}

/** Apply a loaded/saved config wholesale (session_start restore). *//** Apply a loaded/saved config wholesale (session_start restore). */
export function applyConfig(loaded: LoadedConfig): void {
	layers = {
		global: loaded.global,
		project: loaded.project?.layer,
		authored: loaded.authored,
		projectRoot: loaded.project?.projectRoot,
		projectFile: loaded.project?.filePath,
		matchedVia: loaded.project?.matchedVia,
	};
	configWarnings = [...loaded.warnings];
	rebuildEffective();
}

/** The layers currently in effect, with provenance (for diagnostics/UI). */
export function getLayers(): {
	global: PathGuardLayer;
	project?: PathGuardLayer;
	authored?: AuthoredLayer;
	projectRoot?: string;
	projectFile?: string;
	matchedVia?: "exact" | "ancestor";
} {
	return { ...layers };
}

function describePaths(
	layer: PathGuardLayer | undefined,
	name: PathLayerName,
	file: string,
	base: string,
	kind: PathKind,
): ScopedPathEntry[] {
	const raw =
		(kind === "trusted" ? layer?.trustedPaths : layer?.extraProtected) ?? [];
	return raw.map((entry) => ({
		raw: entry,
		normalized: normalizeProtectedEntry(entry, base),
		layer: name,
		file,
	}));
}

/** First occurrence of a normalized path wins; later layers cannot duplicate it. */
function dedupeEntries(entries: ScopedPathEntry[]): ScopedPathEntry[] {
	const seen = new Set<string>();
	const out: ScopedPathEntry[] = [];
	for (const entry of entries) {
		if (seen.has(entry.normalized)) continue;
		seen.add(entry.normalized);
		out.push(entry);
	}
	return out;
}

/** Recompute the effective config from the layered state. */
function rebuildEffective(): void {
	// A hand-authored project block only applies when no projects entry matched.
	const overlay = layers.project ?? layers.authored?.layer;
	const overlayName: PathLayerName = layers.project ? "project" : "authored";
	const overlayFile = layers.project
		? (layers.projectFile ?? "")
		: (layers.authored?.file ?? "");
	const overlayBase = layers.project
		? (layers.projectRoot ?? HOME)
		: (layers.authored?.root ?? HOME);
	const merged = mergeLayers(layers.global, overlay);
	const build = (kind: PathKind): ScopedPathEntry[] =>
		dedupeEntries([
			...describePaths(layers.global, "global", globalSettingsPath(), HOME, kind),
			...(overlay
				? describePaths(overlay, overlayName, overlayFile, overlayBase, kind)
				: []),
		]);
	scopedPaths = { protected: build("protected"), trusted: build("trusted") };
	config = {
		mode: merged.mode ?? "normal",
		extraProtected: scopedPaths.protected.map((e) => e.normalized),
		trustedPaths: scopedPaths.trusted.map((e) => e.normalized),
		rules: merged.rules ?? {},
	};
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
