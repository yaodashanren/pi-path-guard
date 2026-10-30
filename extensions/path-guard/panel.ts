import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { Component, Focusable } from "@earendil-works/pi-tui";
import { Input, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NAKED_SWITCH_WARNING_1, NAKED_SWITCH_WARNING_2, TRUSTED_SWITCH_WARNING, TRUST_PATH_WARNING } from "./constants.ts";
import { projectEntryPath, readSettingsFile, writeFileAtomic } from "./store.ts";
import { resolveReal } from "./paths.ts";
import { doctorView } from "./doctor.ts";
import { applyConfig, getConfigWarnings, getLayers, projectSettingsPath, readSavedConfig } from "./rules.ts";
import type { ConfigWarning, PathGuardLayer, RuleGroup, RuleGroupId } from "./schema.ts";
import { DEFAULT_MODES, GUARD_MODES, MODE_DESCRIPTIONS, RULE_DESCRIPTIONS, RULE_GROUPS, RULE_IDS, RULE_LEVELS, RULE_LEVEL_LABELS, addPathIn, clearPathsIn, ensureProjectLayer, getConfig, globalSettingsPath, getMode, getWriteScope, pathEntries, setWriteScope, isGuardMode, isRuleLevel, isSessionPassed, normalizeInScope, normalizeProtectedEntry, pathList, persistNote, removePathIn, resetAllRulesIn, resetModeIn, rlFor, ruleProvenance, provenanceSuffix, setModeIn, setRuleIn, sessionPassList, setMode, untrustableReason, type ConfigScope, type GuardMode, type PathKind, type RuleId, type RuleLevel } from "./rules.ts";

// path-guard — /guard interactive UI: chained menus, actions, rules matrix,
// the single self-contained overlay panel, and warning confirmations.

/**
 * Level shown in the UI for a (mode, rule) pair. A session pass outranks every
 * persisted layer and is what `rl()` returns, so the displayed level must honour
 * it — otherwise a row reads `(confirm, session-pass)` while the real verdict is
 * `pass`, contradicting the judgement precedence the suffix claims to mirror.
 */
function displayLevel(mode: GuardMode, rule: RuleId): RuleLevel {
	return isSessionPassed(mode, rule) ? "pass" : rlFor(mode, rule);
}

/** Switch the active mode: update config, refresh the footer, persist. Confirm first. */
export function actionSwitchMode(
	mode: GuardMode,
	ctx: ExtensionCommandContext,
	scope: ConfigScope = getWriteScope(),
): string {
	const where = setModeIn(scope, mode, ctx.cwd);
	setMode(getConfig().mode, ctx.ui);
	return `Path Guard switched to: ${mode} (${persistNote(where)})`;
}

/** Set one rule override for a mode (block/confirm/pass). */
export function actionSetRule(
	mode: GuardMode,
	rule: RuleId,
	level: RuleLevel,
	ctx: ExtensionCommandContext,
	scope: ConfigScope = getWriteScope(),
): string {
	const where = setRuleIn(scope, mode, rule, level, ctx.cwd);
	return `Path Guard: set ${mode}.${rule} = ${level} (${persistNote(where)})`;
}

/** Reset one rule to its built-in default (drops the override). */
export function actionResetRule(
	mode: GuardMode,
	rule: RuleId,
	ctx: ExtensionCommandContext,
	scope: ConfigScope = getWriteScope(),
): string {
	const where = setRuleIn(scope, mode, rule, "default", ctx.cwd);
	return `Path Guard: ${mode}.${rule} back to default ${DEFAULT_MODES[mode][rule]} (${persistNote(where)})`;
}

/** Reset every override of one mode to built-in defaults. */
export function actionResetMode(
	mode: GuardMode,
	ctx: ExtensionCommandContext,
	scope: ConfigScope = getWriteScope(),
): string {
	const where = resetModeIn(scope, mode, ctx.cwd);
	return `Path Guard: reset mode ${mode} to defaults (${persistNote(where)})`;
}

/** Clear all rule overrides for every mode. */
export function actionResetAllRules(
	ctx: ExtensionCommandContext,
	scope: ConfigScope = getWriteScope(),
): string {
	const where = resetAllRulesIn(scope, ctx.cwd);
	return `Path Guard: cleared all rule overrides (${persistNote(where)})`;
}

/**
 * Add a path entry. Returns the notify/status message. For `trusted`, callers
 * must show the warning confirmation first — this still re-checks that the path
 * is trustable (defence in depth) and reports "already" rather than duplicating.
 */
export function actionAddPath(
	kind: PathKind,
	input: string,
	ctx: ExtensionCommandContext,
	scope: ConfigScope = getWriteScope(),
): string {
	const norm = normalizeInScope(scope, input);
	if (kind === "trusted") {
		const denied = untrustableReason(norm);
		if (denied) return `Path Guard: cannot trust ${norm} — ${denied}`;
	}
	const result = addPathIn(scope, kind, input, ctx.cwd);
	if (result.error) return `Path Guard: ${result.error}`;
	return `Path Guard: added ${kind} path ${result.normalized ?? norm} (${persistNote(result.where)})`;
}

/** Remove a (normalized) path entry from the layer that owns it. */
export function actionRemovePath(
	kind: PathKind,
	target: string,
	ctx: ExtensionCommandContext,
	scope: ConfigScope = getWriteScope(),
): string {
	const result = removePathIn(scope, kind, target, ctx.cwd);
	if (result.error) return `Path Guard: ${result.error}`;
	return `Path Guard: removed ${kind} path ${target} (${persistNote(result.where!)})`;
}

/** Clear every entry of a path category in one layer. */
export function actionClearPaths(
	kind: PathKind,
	ctx: ExtensionCommandContext,
	scope: ConfigScope = getWriteScope(),
): string {
	const result = clearPathsIn(scope, kind, ctx.cwd);
	if (result.error) return `Path Guard: ${result.error}`;
	const kept = result.kept ? `, ${result.kept} inherited kept` : "";
	return `Path Guard: cleared ${result.cleared} ${kind} path(s) in the ${scope} layer${kept} (${persistNote(result.where!)})`;
}

/**
 * Clear every entry of a path category in one layer — but only after the user
 * confirms (destructive: wipes ALL entries of that category in the layer).
 * Without a UI there is no way to confirm, so the operation is refused and the
 * user is pointed at the settings file to edit manually.
 */
export async function confirmClearPaths(
	kind: PathKind,
	ctx: ExtensionCommandContext,
	scope: ConfigScope = getWriteScope(),
): Promise<string> {
	if (!ctx.hasUI) {
		const file =
			scope === "global"
				? globalSettingsPath()
				: (getLayers().projectFile ?? projectSettingsPath(ctx.cwd));
		return `Path Guard: clearing all ${kind} paths needs a UI to confirm — edit ${file ?? `the ${scope} settings file`} manually instead`;
	}
	const own = pathEntries(kind).filter((entry) => entry.layer === scope);
	if (own.length > 0) {
		const inherited = pathList(kind).length - own.length;
		const ok = await ctx.ui.confirm(
			`Clear ALL ${own.length} ${kind} path(s) in the ${scope} layer?`,
			own.map((entry) => `· ${entry.normalized}`).join("\n") +
				(inherited > 0
					? `\n\n${inherited} inherited path(s) stay in effect.`
					: ""),
		);
		if (!ok) return "Path Guard: cancelled, nothing cleared";
	}
	return actionClearPaths(kind, ctx, scope);
}

export const GUARD_MAIN_MENU = [
	"switch — Switch mode (切换防护模式)",
	"rules — Customize per-mode guard rules (定制每模式守护规则)",
	"paths — Manage protected & trusted paths (管理保护/信任路径)",
	"scope — Where edits are saved: global or this project (切换保存位置)",
	"doctor — Show effective config & diagnostics (诊断视图)",
];

/** First step inside /guard paths: pick a category (loops until back/cancel). */
export const GUARD_PATHS_CATEGORY_MENU = [
	"protected — Custom protected paths (自定义受保护路径)",
	"trusted — Trusted paths, always allowed (信任路径，始终放行)",
	"back — Back to main menu (返回)",
];

/** Second step: per-category actions (loops until back to the category chooser). */
export function pathsActionsMenu(kind: PathKind): string[] {
	return [
		kind === "trusted"
			? "add — Add a trusted path (添加信任路径)"
			: "add — Add a protected path (添加受保护路径)",
		kind === "trusted"
			? "remove — Remove a trusted path (删除信任路径)"
			: "remove — Remove a protected path (删除受保护路径)",
		`clear — Clear all ${kind} paths (清空全部${kind === "trusted" ? "信任" : "受保护"}路径)`,
		"back — Back to path categories (返回分类)",
	];
}

/**
 * Interactive mode picker: decision matrix as the title, one of the 5 modes
 * as the choice. Switches mode (with the trusted/naked warning) and persists.
 * Returns true if a switch happened, false on cancel/invalid.
 */
export async function runModePicker(ctx: ExtensionCommandContext): Promise<boolean> {
	const choices = GUARD_MODES.map(
		(mo) =>
			`${mo} — ${MODE_DESCRIPTIONS[mo]}${mo === getMode() ? " (current)" : ""}`,
	);
	const chosen = await ctx.ui.select(
		`${rulesMatrix()}\n\nCurrent mode: ${getMode()} — choose one:`,
		choices,
	);
	if (!chosen) {
		ctx.ui.notify("Cancelled, mode unchanged", "info");
		return false;
	}
	const picked = chosen.split(/\s+/)[0] as GuardMode;
	if (!isGuardMode(picked)) return false;
	if (!(await confirmModeSwitch(picked, ctx))) {
		ctx.ui.notify(
			`Cancelled: switching to ${picked} requires confirmation`,
			"info",
		);
		return false;
	}
	ctx.ui.notify(actionSwitchMode(picked, ctx), "info");
	return true;
}

/**
 * Interactive management of paths. First picks a category (protected | trusted),
 * then loops add / remove / clear for that category until back returns here / exits.
 */
export async function runPathsMenu(ctx: ExtensionCommandContext): Promise<void> {
	while (true) {
		const category = await ctx.ui.select(
			"Path Guard — choose a path category:",
			GUARD_PATHS_CATEGORY_MENU,
		);
		if (!category) {
			ctx.ui.notify("Cancelled, paths unchanged", "info");
			return;
		}
		const kind = category.split(/\s+/)[0];
		if (kind === "back") return;
		if (kind === "protected" || kind === "trusted") {
			await runPathCategoryMenu(kind, ctx);
		}
	}
}

/**
 * Chained-menu fallback for the write scope: the overlay has its own screen, but
 * hosts without ctx.ui.custom still need a way to choose where edits are saved.
 */
export async function runScopeMenu(ctx: ExtensionCommandContext): Promise<void> {
	const current = getWriteScope();
	const chosen = await ctx.ui.select(
		`Path Guard — where should edits be saved? (current: ${current})`,
		scopeOptions(),
	);
	if (!chosen) {
		ctx.ui.notify("Cancelled, write scope unchanged", "info");
		return;
	}
	const id = chosen.split(/\s+/)[0];
	if (id === "global") {
		setWriteScope("global");
		ctx.ui.notify("Path Guard: edits now save to global settings", "info");
		return;
	}
	if (id === "project") {
		const ensured = ensureProjectLayer(ctx.cwd);
		if (ensured.ok) {
			setWriteScope("project");
			ctx.ui.notify(
				`Path Guard: edits now save to this project (${getLayers().projectFile})`,
				"info",
			);
		} else {
			ctx.ui.notify(`Path Guard: ${ensured.error}`, "warning");
		}
	}
}

/** Add/remove/clear loop for one path category; "back" returns to the category chooser. */
export async function runPathCategoryMenu(
	kind: PathKind,
	ctx: ExtensionCommandContext,
): Promise<void> {
	while (true) {
		const list = pathList(kind);
		if (list.length > 0) {
			ctx.ui.notify(
				`Path Guard ${kind} paths (${list.length}):\n` +
					list.map((p) => `· ${p}`).join("\n"),
				"info",
			);
		} else {
			ctx.ui.notify(`Path Guard: no ${kind} paths configured`, "info");
		}

		const action = await ctx.ui.select(
			"Choose an action:",
			pathsActionsMenu(kind),
		);
		if (!action) {
			ctx.ui.notify(`Cancelled, ${kind} paths unchanged`, "info");
			return;
		}
		const op = action.split(/\s+/)[0];
		if (op === "back") return;

		if (op === "add") {
			const input = await ctx.ui.input(
				kind === "trusted"
					? "Enter the path to ALWAYS trust (absolute, or relative to cwd):"
					: "Enter the path to protect (absolute, or relative to cwd):",
				"",
			);
			if (input == null) {
				ctx.ui.notify("Cancelled add", "info");
				continue;
			}
			const norm = normalizeProtectedEntry(input, ctx.cwd);
			if (kind === "trusted") {
				const denied = untrustableReason(norm);
				if (denied) {
					ctx.ui.notify(`Path Guard: cannot trust ${norm} — ${denied}`, "warning");
					continue;
				}
				if (!(await confirmTrustPath(ctx))) {
					ctx.ui.notify(
						`Path Guard: not added — trusting ${norm} requires confirmation`,
						"info",
					);
					continue;
				}
			}
			ctx.ui.notify(actionAddPath(kind, input, ctx), "info");
			continue;
		}

		if (op === "remove") {
			if (list.length === 0) {
				ctx.ui.notify(`Path Guard: no ${kind} paths to remove`, "info");
				continue;
			}
			const target = await ctx.ui.select("Choose a path to remove:", [...list]);
			if (!target) {
				ctx.ui.notify("Cancelled remove", "info");
				continue;
			}
			ctx.ui.notify(actionRemovePath(kind, target, ctx), "info");
			continue;
		}

		if (op === "clear") {
			const own = pathEntries(kind).filter(
				(entry) => entry.layer === getWriteScope(),
			);
			if (own.length === 0) {
				ctx.ui.notify(
					`Path Guard: no ${kind} paths owned by the ${getWriteScope()} layer to clear`,
					"info",
				);
				continue;
			}
			const inherited = list.length - own.length;
			const ok = await ctx.ui.confirm(
				`Clear ALL ${own.length} ${kind} path(s) in the ${getWriteScope()} layer?`,
				own.map((entry) => `· ${entry.normalized}`).join("\n") +
					(inherited > 0
						? `\n\n${inherited} inherited path(s) stay in effect.`
						: ""),
			);
			if (!ok) {
				ctx.ui.notify("Cancelled clear", "info");
				continue;
			}
			ctx.ui.notify(actionClearPaths(kind, ctx), "info");
		}
	}
}

/**
 * Sub-menu for customizing per-mode guard rules (loops until back/cancel):
 * mode → pick a mode → rule editor; overview → read-only matrix; reset → clear ALL overrides.
 */
export const GUARD_RULES_MENU = [
	"mode — Pick a mode to customize (选择要定制的模式)",
	"overview — Show the full mode×rule matrix (查看完整规则矩阵)",
	"reset — Clear ALL rule overrides (清空全部规则覆盖)",
	"back — Back to main menu (返回)",
];

/** Widget id used to render the full effective rules matrix above the editor. */
export const OVERVIEW_WIDGET = "path-guard-overview";

/**
 * Show the full rules matrix above the editor. Only used by the legacy chained
 * fallback menus (the overlay renders the matrix in its own overview screen).
 */
export async function showMatrixViewer(
	ctx: ExtensionCommandContext,
	matrix: string,
): Promise<void> {
	ctx.ui.setWidget(OVERVIEW_WIDGET, matrix.split("\n"));
	ctx.ui.notify(
		"Effective rules matrix shown above the editor (返回以收起)",
		"info",
	);
}

/** The effective (override-aware) rule matrix as a readable table. */
export function rulesMatrix(): string {
	const head =
		"rule".padEnd(30) + GUARD_MODES.map((mo) => mo.padStart(8)).join("");
	const rows = RULE_IDS.map((r) => {
		const cell = (l: RuleLevel) =>
			l === "block" ? "B" : l === "confirm" ? "?" : ".";
		return (
			r.padEnd(30) +
			GUARD_MODES.map((mo) => cell(rlFor(mo, r)).padStart(8)).join("")
		);
	});
	// Surface confirm-dialog session passes — they are not in `config.rules`.
	const session: string[] = [];
	for (const mo of GUARD_MODES) {
		for (const r of sessionPassList(mo)) session.push(`${mo}.${r}`);
	}
	const note = session.length
		? `\n\nSession-only pass (not persisted): ${session.sort().join(", ")}`
		: "";
	return `Path Guard effective rules matrix (B=block ?=confirm .=pass):\n${head}\n${rows.join("\n")}${note}`;
}

/** Human-readable list of the current rule overrides (or a notice if none). */
export function rulesSummary(): string {
	const out: string[] = [];
	for (const mo of GUARD_MODES) {
		const ov = getConfig().rules[mo];
		if (!ov) continue;
		for (const r of RULE_IDS) {
			if (ov[r] !== undefined) out.push(`${mo}.${r} = ${ov[r]}`);
		}
	}
	return out.length
		? `Path Guard rule overrides (${out.length}):\n` + out.join("\n")
		: "Path Guard: no rule overrides — all modes use built-in defaults";
}

/**
 * Level picker for a single rule in a mode. Picks block/confirm/pass, or reset
 * (delete the override so the built-in default applies). Returns to the caller,
 * which then re-shows the rule list — that's the "loop" letting the user set
 * several rules in one mode without re-navigating.
 */
export async function ruleLevelPicker(
	mode: GuardMode,
	rule: RuleId,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const dflt = DEFAULT_MODES[mode][rule];
	const cur = displayLevel(mode, rule);
	const options = [
		...RULE_LEVELS.map(
			(l) =>
				`${RULE_LEVEL_LABELS[l]}${l === cur ? " (current)" : ""}${l === dflt ? " [default]" : ""}`,
		),
		`reset — back to built-in default (${dflt}) (恢复该条默认)`,
		"back — Back to rule list (返回)",
	];
	const picked = await ctx.ui.select(
		`Mode: ${mode} · Rule: ${rule} — ${RULE_DESCRIPTIONS[rule]}\n` +
			`Current: ${cur} · Built-in default: ${dflt}`,
		options,
	);
	if (!picked) return;
	const op = picked.split(/\s+/)[0];
	if (op === "back") return;
	if (op === "reset") {
		ctx.ui.notify(actionResetRule(mode, rule, ctx), "info");
		return;
	}
	if (isRuleLevel(op)) {
		ctx.ui.notify(actionSetRule(mode, rule, op, ctx), "info");
	}
}

/**
 * Options for the first (group) level of the rule editor: one row per rule
 * group (`${label} (${N} rules, ${M} overrides)`) plus reset and back.
 *
 * `M` counts only PERSISTED overrides — provenance ∈ {global, project}. A
 * session-only pass is not a stored override, so it is not counted.
 *
 * Shared verbatim with the /guard overlay (Task 4) so both entries render the
 * identical list; `reset` stays at this level (it resets the whole mode).
 */
export function ruleGroupOptions(mode: GuardMode): string[] {
	return [
		...RULE_GROUPS.map((g) => {
			const overrides = g.rules.filter((r) => {
				const p = ruleProvenance(mode, r);
				return p === "global" || p === "project";
			}).length;
			return `${g.label} (${g.rules.length} rules, ${overrides} overrides)`;
		}),
		"reset — Reset this mode to built-in defaults (恢复该模式默认)",
		"back — Back to mode list (返回)",
	];
}

/**
 * Options for the second (rule) level of the rule editor: the rows of ONE
 * group (`${rule} — ${description} (${level}${provenanceSuffix})`) plus back.
 * `reset` is deliberately absent — it resets the whole mode, so it stays on
 * the group level. Shared by the CLI editor and the /guard overlay so the two
 * entries cannot drift apart.
 */
export function ruleRowOptions(mode: GuardMode, group: RuleGroup): string[] {
	return [
		...group.rules.map(
			(r) =>
				`${r} — ${RULE_DESCRIPTIONS[r]} (${displayLevel(mode, r)}${provenanceSuffix(mode, r)})`,
		),
		"back — Back to group list (返回)",
	];
}

/**
 * Rule editor for one mode, two levels deep: first pick a rule group (the
 * per-group override counts are shown on each row), then a rule inside it.
 * The level pick returns to the same group list, so several rules can be set
 * in a row; reset (whole mode) and back live on the group level.
 */
export async function runModeEditor(
	mode: GuardMode,
	ctx: ExtensionCommandContext,
): Promise<void> {
	while (true) {
		const title =
			`Mode: ${mode} — pick a rule group (current levels shown):\n` +
			RULE_GROUPS.map(
				(g) =>
					`  ${g.label}: ${g.rules.map((r) => `${r}=${displayLevel(mode, r)}`).join(", ")}`,
			).join("\n");
		const picked = await ctx.ui.select(title, ruleGroupOptions(mode));
		if (!picked) {
			ctx.ui.notify("Cancelled, rules unchanged", "info");
			return;
		}
		const op = picked.split(/\s+/)[0];
		if (op === "back") return;
		if (op === "reset") {
			const ok = await ctx.ui.confirm(
				`Reset mode "${mode}" to built-in defaults?`,
				"",
			);
			if (!ok) continue;
			ctx.ui.notify(actionResetMode(mode, ctx), "info");
			continue;
		}
		const group = RULE_GROUPS.find(
			(g) => picked.startsWith(g.label) || g.id === op,
		);
		if (!group) continue;
		if (!(await runRuleGroupEditor(mode, group, ctx))) return;
	}
}

/**
 * Second level of the rule editor: the group's rules (level + provenance
 * suffix) plus back. Returns false when the user cancelled the whole editor,
 * true when it is time to show the group list again.
 */
async function runRuleGroupEditor(
	mode: GuardMode,
	group: RuleGroup,
	ctx: ExtensionCommandContext,
): Promise<boolean> {
	while (true) {
		const options = ruleRowOptions(mode, group);
		const picked = await ctx.ui.select(
			`Mode: ${mode} · ${group.label} — pick a rule to set (level + source shown):`,
			options,
		);
		if (!picked) {
			ctx.ui.notify("Cancelled, rules unchanged", "info");
			return false;
		}
		const op = picked.split(/\s+/)[0];
		if (op === "back") return true;
		const rule = group.rules.find((r) => r === op);
		if (rule) await ruleLevelPicker(mode, rule, ctx);
	}
}

/**
 * Mode sub-menu: the 5 modes (each showing override count / current), plus
 * reset (reset a single mode) and back.
 */
export async function runModeSubmenu(ctx: ExtensionCommandContext): Promise<void> {
	while (true) {
		const options = [
			...GUARD_MODES.map((mo) => {
				const n = Object.keys(getConfig().rules[mo] ?? {}).length;
				return `${mo} — ${MODE_DESCRIPTIONS[mo]}${n ? ` (${n} overrides)` : ""}${mo === getMode() ? " (current)" : ""}`;
			}),
			"reset — Reset a mode to built-in defaults (恢复某模式默认)",
			"back — Back to rules menu (返回)",
		];
		const picked = await ctx.ui.select("Pick a mode to customize:", options);
		if (!picked) {
			ctx.ui.notify("Cancelled, rules unchanged", "info");
			return;
		}
		const op = picked.split(/\s+/)[0];
		if (op === "back") return;
		if (op === "reset") {
			const target = await ctx.ui.select(
				"Reset which mode to its built-in defaults?",
				GUARD_MODES.map((mo) => `${mo} — ${MODE_DESCRIPTIONS[mo]}`),
			);
			if (!target) continue;
			const mo = target.split(/\s+/)[0] as GuardMode;
			if (!isGuardMode(mo)) continue;
			const ok = await ctx.ui.confirm(
				`Reset mode "${mo}" to built-in defaults?`,
				"",
			);
			if (!ok) continue;
			ctx.ui.notify(actionResetMode(mo, ctx), "info");
			continue;
		}
		if (isGuardMode(op)) await runModeEditor(op, ctx);
	}
}

/**
 * Main rules menu (loops until back/cancel). Each iteration shows a summary of
 * current overrides; overview shows the full matrix on demand.
 */
export async function runRulesMenu(ctx: ExtensionCommandContext): Promise<void> {
	// The full matrix is far too large for a notify popup, so it is rendered as a
	// persistent read-only widget above the editor and cleared when leaving the menu.
	const clearOverview = () => {
		try {
			ctx.ui.setWidget(OVERVIEW_WIDGET, undefined);
		} catch {
			/* widget API unavailable (e.g. bare mock / print mode) */
		}
	};
	while (true) {
		ctx.ui.notify(rulesSummary(), "info");
		const action = await ctx.ui.select("Choose an action:", GUARD_RULES_MENU);
		if (!action) {
			clearOverview();
			ctx.ui.notify("Cancelled, rules unchanged", "info");
			return;
		}
		const op = action.split(/\s+/)[0];
		if (op === "back") {
			clearOverview();
			return;
		}
		if (op === "overview") {
			await showMatrixViewer(ctx, rulesMatrix());
			continue;
		}
		if (op === "reset") {
			const ok = await ctx.ui.confirm(
				`Clear ALL rule overrides in the ${getWriteScope()} layer?`,
				"Reset every mode back to its built-in defaults?",
			);
			if (!ok) continue;
			ctx.ui.notify(actionResetAllRules(ctx), "info");
			continue;
		}
		if (op === "mode") await runModeSubmenu(ctx);
	}
}

// ─── Interactive /guard overlay (single self-contained popup) ──────────
// B1: the whole /guard settings flow (mode / rules / paths, including all
// confirmations and the path text input) lives inside ONE floating overlay
// component. The tool_call interception prompts are unrelated and still use the
// host's built-in ctx.ui.select/confirm.

/** One screen in the /guard overlay navigation stack (the top of the stack is shown). */
export type PanelScreen =
	| { kind: "main"; idx: number }
	| { kind: "scope"; idx: number }
	| { kind: "mode"; idx: number }
	| { kind: "rules"; idx: number }
	| { kind: "ruleMode"; idx: number }
	| { kind: "ruleGroup"; mode: GuardMode; idx: number }
	| { kind: "ruleEditor"; mode: GuardMode; group: RuleGroupId; idx: number }
	| { kind: "ruleLevel"; mode: GuardMode; rule: RuleId; idx: number }
	| { kind: "overview"; scroll: number }
	| { kind: "doctor"; idx: number }
	| { kind: "pathsCategory"; idx: number }
	| { kind: "pathsActions"; pathKind: PathKind; idx: number }
	| { kind: "resetModePick"; idx: number }
	| { kind: "pathsRemove"; pathKind: PathKind; idx: number }
	| { kind: "pathsAdd"; pathKind: PathKind };

/** An in-panel yes/no confirmation (never offered by the direct /guard <mode> shortcut). */
export interface PendingConfirm {
	title: string;
	body: string;
	onConfirm: () => void;
}

/** Minimal theme surface the panel uses (kept loose so test mocks are accepted). */
export type PanelTheme = { fg: (color: any, text: string) => string };

/** Labels for the write-scope picker (global layer vs this project's entry file). */
export function scopeOptions(): string[] {
	const layers = getLayers();
	const project = layers.projectFile
		? `project — Save to this project's entry file (${layers.projectFile})${layers.matchedVia === "ancestor" ? " [from a parent directory]" : ""}`
		: "project — (no project config for this directory yet — this creates one)";
	return [
		`global — Save to global settings (${globalSettingsPath()})${getWriteScope() === "global" ? " (current)" : ""}`,
		`${project}${getWriteScope() === "project" ? " (current)" : ""}`,
		"back — Back to main menu (返回)",
	];
}

/** The option labels for a screen; the leading token is the action id. */
export function panelOptions(s: PanelScreen): string[] {
	switch (s.kind) {
		case "main":
			return GUARD_MAIN_MENU;
		case "scope":
			return scopeOptions();
		case "mode":
			return GUARD_MODES.map(
				(mo) =>
					`${mo} — ${MODE_DESCRIPTIONS[mo]}${mo === getMode() ? " (current)" : ""}`,
			);
		case "rules":
			return GUARD_RULES_MENU;
		case "ruleMode":
			return [
				...GUARD_MODES.map((mo) => {
					const n = Object.keys(getConfig().rules[mo] ?? {}).length;
					return `${mo} — ${MODE_DESCRIPTIONS[mo]}${n ? ` (${n} overrides)` : ""}${mo === getMode() ? " (current)" : ""}`;
				}),
				"reset — Reset a mode to built-in defaults (恢复某模式默认)",
				"back — Back to rules menu (返回)",
			];
		case "resetModePick":
			return [
				...GUARD_MODES.map((mo) => `${mo} — ${MODE_DESCRIPTIONS[mo]}`),
				"back — Back (返回)",
			];
		case "ruleGroup":
			return ruleGroupOptions(s.mode);
		case "ruleEditor": {
			const group = RULE_GROUPS.find((g) => g.id === s.group);
			return group
				? ruleRowOptions(s.mode, group)
				: ["back — Back to group list (返回)"];
		}
		case "ruleLevel":
			return [
				...RULE_LEVELS.map(
					(l) =>
						`${RULE_LEVEL_LABELS[l]}${l === displayLevel(s.mode, s.rule) ? " (current)" : ""}${l === DEFAULT_MODES[s.mode][s.rule] ? " [default]" : ""}`,
				),
				`reset — back to built-in default (${DEFAULT_MODES[s.mode][s.rule]}) (恢复该条默认)`,
				"back — Back to rule list (返回)",
			];
		case "pathsCategory":
			return GUARD_PATHS_CATEGORY_MENU;
		case "pathsActions":
			return pathsActionsMenu(s.pathKind);
		case "pathsRemove":
			return [...pathList(s.pathKind), "back — Back to actions (返回)"];
		case "doctor":
			return ["back — Back (返回)"];
		case "pathsAdd":
		case "overview":
			return [];
	}
}

/** Draw a bordered dialog frame around inner lines, clamped to the render width. */
export function framePanel(inner: string[], width: number): string[] {
	const w = Math.max(2, width);
	const contentW = Math.max(0, w - 2);
	const top = "┌" + "─".repeat(contentW) + "┐";
	const bottom = "└" + "─".repeat(contentW) + "┘";
	const body = inner.map((line) => {
		const t = truncateToWidth(line, contentW, "…");
		const pad = " ".repeat(Math.max(0, contentW - visibleWidth(t)));
		return "│" + t + pad + "│";
	});
	return [top, ...body, bottom];
}

/**
 * The self-contained /guard settings popup: a small screen-stack state machine
 * rendered as one floating overlay. It owns its own confirmations and its own
 * single-line path input, so nothing else is shown while it is open.
 */
export class GuardPanel implements Component, Focusable {
	/** Focusable — set by the TUI so the embedded Input can position the cursor. */
	focused = false;

	private stack: PanelScreen[] = [{ kind: "main", idx: 0 }];
	private confirmState: PendingConfirm | null = null;
	private confirmIdx = 0;
	private status = "";
	private addInput: Input | null = null;

	private ctx: ExtensionCommandContext;
	private theme: PanelTheme;
	private requestRender: () => void;
	private done: (result: void) => void;

	constructor(
		ctx: ExtensionCommandContext,
		theme: PanelTheme,
		requestRender: () => void,
		done: (result: void) => void,
	) {
		this.ctx = ctx;
		this.theme = theme;
		this.requestRender = requestRender;
		this.done = done;
	}

	private current(): PanelScreen {
		return this.stack[this.stack.length - 1];
	}

	private push(s: PanelScreen): void {
		this.stack.push(s);
		if (s.kind === "pathsAdd") {
			this.addInput = new Input({
				placeholder: "absolute, ~, or path relative to cwd",
			});
			this.addInput.onSubmit = (v) => this.submitAdd(v);
			this.addInput.onEscape = () => this.pop();
		}
		this.requestRender();
	}

	private pop(): void {
		if (this.stack.length <= 1) {
			this.done();
			return;
		}
		const leaving = this.current();
		this.stack.pop();
		if (leaving.kind === "pathsAdd") this.addInput = null;
		this.requestRender();
	}

	private goMain(): void {
		this.stack = [{ kind: "main", idx: 0 }];
		this.addInput = null;
		this.requestRender();
	}

	private move(delta: number): void {
		const s = this.current();
		const n = panelOptions(s).length;
		if (n === 0 || !("idx" in s)) return;
		s.idx = Math.max(0, Math.min(n - 1, s.idx + delta));
	}

	private askConfirm(title: string, body: string, onConfirm: () => void): void {
		this.confirmState = { title, body, onConfirm };
		this.confirmIdx = 0;
		this.requestRender();
	}

	private resolveConfirm(yes: boolean): void {
		const c = this.confirmState;
		this.confirmState = null;
		this.requestRender();
		if (c && yes) c.onConfirm();
	}

	private requestModeSwitch(mode: GuardMode): void {
		if (mode === "trusted") {
			this.askConfirm("⚠️ Switch to trusted mode?", TRUSTED_SWITCH_WARNING, () =>
				this.doSwitch(mode),
			);
		} else if (mode === "naked") {
			this.askConfirm(
				"⚠️ Switch to NAKED mode?",
				NAKED_SWITCH_WARNING_1,
				() =>
					this.askConfirm(
						"⚠️⚠️ FINAL confirmation — disable ALL protection?",
						NAKED_SWITCH_WARNING_2,
						() => this.doSwitch(mode),
					),
			);
		} else {
			this.doSwitch(mode);
		}
	}

	private doSwitch(mode: GuardMode): void {
		this.status = actionSwitchMode(mode, this.ctx);
		this.goMain();
	}

	private submitAdd(raw: string): void {
		const s = this.current();
		if (s.kind !== "pathsAdd") return;
		const kind = s.pathKind;
		if (!raw.trim()) return;
		if (kind === "trusted") {
			const norm = normalizeProtectedEntry(raw, this.ctx.cwd);
			const denied = untrustableReason(norm);
			if (denied) {
				this.status = `Path Guard: cannot trust ${norm} — ${denied}`;
				this.requestRender();
				return;
			}
			this.askConfirm("⚠️ Trust this path?", TRUST_PATH_WARNING, () => {
				this.status = actionAddPath(kind, raw, this.ctx);
				this.pop();
			});
			return;
		}
		this.status = actionAddPath(kind, raw, this.ctx);
		this.pop();
	}

	private activate(): void {
		const s = this.current();
		const opts = panelOptions(s);
		if (opts.length === 0) return;
		const id = opts[(s as { idx: number }).idx].split(/\s+/)[0];
		switch (s.kind) {
			case "main":
				if (id === "switch") this.push({ kind: "mode", idx: 0 });
				else if (id === "scope") this.push({ kind: "scope", idx: 0 });
				else if (id === "rules") this.push({ kind: "rules", idx: 0 });
				else if (id === "paths")
					this.push({ kind: "pathsCategory", idx: 0 });
				else if (id === "doctor")
					this.push({ kind: "doctor", idx: 0 });
				return;
			case "scope": {
				if (id === "back") {
					this.pop();
					return;
				}
				if (id === "global") {
					setWriteScope("global");
					this.status = "Path Guard: edits now save to global settings";
					this.pop();
					return;
				}
				if (id === "project") {
					const ensured = ensureProjectLayer(this.ctx.cwd);
					if (ensured.ok) {
						setWriteScope("project");
						this.status = `Path Guard: edits now save to this project (${getLayers().projectFile})`;
					} else {
						setWriteScope("global");
						this.status = `Path Guard: ${ensured.error}`;
					}
					this.pop();
				}
				return;
			}
			case "mode": {
				const mode = GUARD_MODES[s.idx];
				if (mode) this.requestModeSwitch(mode);
				return;
			}
			case "rules":
				if (id === "mode") this.push({ kind: "ruleMode", idx: 0 });
				else if (id === "overview")
					this.push({ kind: "overview", scroll: 0 });
				else if (id === "reset")
					this.askConfirm(
						`Clear ALL rule overrides in the ${getWriteScope()} layer?`,
						"Reset every mode back to its built-in defaults?",
						() => {
							this.status = actionResetAllRules(this.ctx);
							this.requestRender();
						},
					);
				else if (id === "back") this.pop();
				return;
			case "ruleMode":
				if (id === "reset") this.push({ kind: "resetModePick", idx: 0 });
				else if (id === "back") this.pop();
				else if (isGuardMode(id))
					this.push({ kind: "ruleGroup", mode: id, idx: 0 });
				return;
			case "resetModePick": {
				if (id === "back") {
					this.pop();
					return;
				}
				if (!isGuardMode(id)) return;
				const mode = id;
				this.askConfirm(
					`Reset mode "${mode}" to built-in defaults?`,
					"",
					() => {
						this.status = actionResetMode(mode, this.ctx);
						this.pop();
					},
				);
				return;
			}
			case "ruleGroup": {
				const mode = s.mode;
				if (id === "reset")
					this.askConfirm(
						`Reset mode "${mode}" to built-in defaults?`,
						"",
						() => {
							this.status = actionResetMode(mode, this.ctx);
							this.requestRender();
						},
					);
				else if (id === "back") this.pop();
				else {
					// Groups are rows 0..RULE_GROUPS.length-1 of this screen and the
					// shared option builder preserves that order — resolve by index
					// (matching on label text would be brittle) and let the explicit
					// reset/back id checks above exclude their rows.
					const group = RULE_GROUPS[s.idx];
					if (group)
						this.push({
							kind: "ruleEditor",
							mode,
							group: group.id,
							idx: 0,
						});
				}
				return;
			}
			case "ruleEditor": {
				const { mode, group: groupId } = s;
				if (id === "back") this.pop();
				else {
					// Rules are rows 0..group.rules.length-1 of this screen.
					const group = RULE_GROUPS.find((g) => g.id === groupId);
					const rule = group?.rules[s.idx];
					if (rule) this.push({ kind: "ruleLevel", mode, rule, idx: 0 });
				}
				return;
			}
			case "ruleLevel": {
				const { mode, rule } = s;
				if (id === "back") this.pop();
				else if (id === "reset") {
					this.status = actionResetRule(mode, rule, this.ctx);
					this.pop();
				} else if (isRuleLevel(id)) {
					this.status = actionSetRule(mode, rule, id, this.ctx);
					this.pop();
				}
				return;
			}
			case "pathsCategory":
				if (id === "protected" || id === "trusted")
					this.push({ kind: "pathsActions", pathKind: id, idx: 0 });
				else if (id === "back") this.pop();
				return;
			case "pathsActions": {
				const kind = s.pathKind;
				if (id === "add") this.push({ kind: "pathsAdd", pathKind: kind });
				else if (id === "remove") {
					if (pathList(kind).length === 0) {
						this.status = `Path Guard: no ${kind} paths to remove`;
						this.requestRender();
					} else this.push({ kind: "pathsRemove", pathKind: kind, idx: 0 });
				} else if (id === "clear") {
					if (pathList(kind).length === 0) {
						this.status = `Path Guard: no ${kind} paths to clear`;
						this.requestRender();
					} else
						this.askConfirm(
							`Clear all ${kind} paths?`,
							`Remove these ${pathList(kind).length} path(s)?\n` +
								pathList(kind)
									.map((p) => `· ${p}`)
									.join("\n"),
							() => {
								this.status = actionClearPaths(kind, this.ctx);
								this.requestRender();
							},
						);
				} else if (id === "back") this.pop();
				return;
			}
			case "pathsRemove": {
				const kind = s.pathKind;
				const list = pathList(kind);
				const entries = pathEntries(kind);
				const target = entries[s.idx];
				if (target && target.layer !== getWriteScope()) {
					this.status = `Path Guard: not removable here — ${target.normalized} belongs to the ${target.layer} config`;
					this.requestRender();
					return;
				}
				if (s.idx >= list.length) {
					this.pop();
					return;
				}
				this.status = actionRemovePath(kind, list[s.idx], this.ctx);
				this.pop();
				return;
			}
			case "doctor":
				if (id === "back") this.pop();
				return;
			case "pathsAdd":
			case "overview":
				return;
		}
	}

	handleInput(data: string): void {
		if (this.confirmState) {
			if (
				matchesKey(data, "up") ||
				matchesKey(data, "down") ||
				matchesKey(data, "left") ||
				matchesKey(data, "right") ||
				matchesKey(data, "tab")
			) {
				this.confirmIdx = this.confirmIdx === 0 ? 1 : 0;
				this.requestRender();
				return;
			}
			if (matchesKey(data, "return") || matchesKey(data, "enter")) {
				this.resolveConfirm(this.confirmIdx === 0);
				return;
			}
			if (matchesKey(data, "escape")) this.resolveConfirm(false);
			return;
		}

		const s = this.current();
		if (s.kind === "pathsAdd") {
			this.addInput?.handleInput(data);
			this.requestRender();
			return;
		}
		if (s.kind === "overview") {
			const maxScroll = Math.max(0, rulesMatrix().split("\n").length - 1);
			if (matchesKey(data, "up")) s.scroll = Math.max(0, s.scroll - 1);
			else if (matchesKey(data, "down"))
				s.scroll = Math.min(maxScroll, s.scroll + 1);
			else if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u"))
				s.scroll = Math.max(0, s.scroll - 10);
			else if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d"))
				s.scroll = Math.min(maxScroll, s.scroll + 10);
			else if (matchesKey(data, "home")) s.scroll = 0;
			else if (matchesKey(data, "end")) s.scroll = maxScroll;
			else if (
				matchesKey(data, "escape") ||
				matchesKey(data, "q") ||
				matchesKey(data, "return") ||
				matchesKey(data, "enter")
			) {
				this.pop();
				return;
			}
			this.requestRender();
			return;
		}

		if (matchesKey(data, "up")) this.move(-1);
		else if (matchesKey(data, "down")) this.move(1);
		else if (matchesKey(data, "return") || matchesKey(data, "enter"))
			this.activate();
		else if (matchesKey(data, "escape")) this.pop();
		else if (matchesKey(data, "q") && s.kind === "main") {
			this.done();
			return;
		}
		this.requestRender();
	}

	/** Windowed selection list (bounded so the panel never grows unbounded). */
	private listLines(items: string[], idx: number, max = 14): string[] {
		if (items.length === 0) return ["(none)"];
		const n = items.length;
		const start = Math.max(0, Math.min(idx - Math.floor(max / 2), n - max));
		const end = Math.min(n, start + max);
		const lines: string[] = [];
		if (start > 0) lines.push(`  … ${start} above`);
		for (let i = start; i < end; i++)
			lines.push(`${i === idx ? "▶ " : "  "}${items[i]}`);
		if (end < n) lines.push(`  … ${n - end} below`);
		return lines;
	}

	private overviewLines(lines: string[], scroll: number): string[] {
		const rows = 14;
		const maxScroll = Math.max(0, lines.length - rows);
		const start = Math.min(scroll, maxScroll);
		const end = Math.min(lines.length, start + rows);
		const out = lines.slice(start, end);
		if (start > 0) out.unshift(`  ↑ ${start} more`);
		if (end < lines.length) out.push(`  ↓ ${lines.length - end} more`);
		return out;
	}

	private footerHint(): string {
		if (this.confirmState) return "↑/↓ choose · ⏎ confirm · esc cancel";
		const s = this.current();
		if (s.kind === "overview")
			return "↑/↓/PgUp/PgDn scroll · ⏎/esc close";
		if (s.kind === "doctor") return "⏎/esc back";
		if (s.kind === "pathsAdd") return "type a path · ⏎ submit · esc back";
		return `↑/↓ move · ⏎ select · esc back${s.kind === "main" ? " · q quit" : ""}`;
	}

	private renderScreen(s: PanelScreen, width: number): string[] {
		const out: string[] = [];
		switch (s.kind) {
			case "scope":
				out.push("Where should /guard save edits?", "");
				out.push(...this.listLines(panelOptions(s), s.idx));
				break;
			case "main":
				out.push("Choose an action:", "");
				out.push(...this.listLines(panelOptions(s), s.idx));
				break;
			case "mode":
				out.push(...rulesMatrix().split("\n"), "");
				out.push(`Current mode: ${getMode()} — choose one:`);
				out.push(...this.listLines(panelOptions(s), s.idx));
				break;
			case "rules":
				out.push(rulesSummary().split("\n")[0], "");
				out.push(...this.listLines(panelOptions(s), s.idx));
				break;
			case "ruleMode":
				out.push("Pick a mode to customize:", "");
				out.push(...this.listLines(panelOptions(s), s.idx));
				break;
			case "resetModePick":
				out.push("Reset which mode to its built-in defaults?", "");
				out.push(...this.listLines(panelOptions(s), s.idx));
				break;
			case "ruleGroup":
				out.push(`Pick a rule group (mode: ${s.mode}):`);
				out.push(...this.listLines(panelOptions(s), s.idx));
				break;
			case "ruleEditor": {
				const group = RULE_GROUPS.find((g) => g.id === s.group);
				out.push(
					`Mode: ${s.mode} · Group: ${group ? group.label : s.group} — pick a rule to set (level + source shown):`,
				);
				out.push(...this.listLines(panelOptions(s), s.idx, 16));
				break;
			}
			case "ruleLevel":
				out.push(
					`Mode: ${s.mode} · Rule: ${s.rule} — ${RULE_DESCRIPTIONS[s.rule]}`,
				);
				out.push(
					`Current: ${displayLevel(s.mode, s.rule)} · Built-in default: ${DEFAULT_MODES[s.mode][s.rule]}`,
					"",
				);
				out.push(...this.listLines(panelOptions(s), s.idx));
				break;
			case "overview":
				out.push(...this.overviewLines(rulesMatrix().split("\n"), s.scroll));
				break;
			case "doctor":
				out.push(...doctorView(this.ctx.cwd).split("\n"), "");
				out.push(...this.listLines(panelOptions(s), s.idx));
				break;
			case "pathsCategory":
				out.push("Choose a path category:", "");
				out.push(...this.listLines(panelOptions(s), s.idx));
				break;
			case "pathsActions": {
				const list = pathList(s.pathKind);
				out.push(`Saving edits to: ${getWriteScope()}`, "");
				out.push(
					`${s.pathKind} paths (${list.length}):`,
					...(list.length
						? list.slice(0, 6).map((p) => `· ${p}`)
						: ["(none)"]),
					"",
				);
				out.push(...this.listLines(panelOptions(s), s.idx));
				break;
			}
			case "pathsRemove": {
				out.push(`Choose a ${s.pathKind} path to remove:`, "");
				const owned = pathEntries(s.pathKind);
				const options = panelOptions(s);
				options.forEach((label, i) => {
					const entry = owned[i];
					if (entry && entry.layer !== getWriteScope()) {
						options[i] = `${label} [from ${entry.layer}]`;
					}
				});
				out.push(...this.listLines(options, s.idx));
				break;
			}
			case "pathsAdd":
				out.push(
					s.pathKind === "trusted"
						? "Enter the path to ALWAYS trust:"
						: "Enter the path to protect:",
					"",
				);
				if (this.addInput)
					out.push(...this.addInput.render(Math.max(20, width - 6)));
				break;
		}
		return out;
	}

	render(width: number): string[] {
		if (this.addInput) this.addInput.focused = this.focused;
		const fg = (color: string, text: string) => {
			try {
				return this.theme.fg(color, text);
			} catch {
				return text;
			}
		};
		const inner: string[] = [
			fg("accent", `Path Guard  ·  mode: ${getMode()} · scope: ${getWriteScope()}`),
			"",
		];
		if (this.confirmState) {
			inner.push(fg("warning", this.confirmState.title));
			for (const line of this.confirmState.body.split("\n")) inner.push(line);
			inner.push("");
			inner.push(`${this.confirmIdx === 0 ? "▶ " : "  "}✅ Confirm (确认)`);
			inner.push(`${this.confirmIdx === 1 ? "▶ " : "  "}❌ Cancel (取消)`);
		} else {
			inner.push(...this.renderScreen(this.current(), width));
		}
		if (this.status) {
			inner.push("");
			for (const line of this.status.split("\n").slice(0, 4))
				inner.push(fg("dim", line));
		}
		inner.push("", fg("dim", this.footerHint()));
		return framePanel(inner, width);
	}

	invalidate(): void {
		/* no cached render state */
	}
}

/** Open the single /guard settings popup as a floating overlay. */
export async function runGuardPanel(ctx: ExtensionCommandContext): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) =>
			new GuardPanel(ctx, theme, () => tui.requestRender(), done),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "80%",
				maxHeight: "80%",
				margin: 1,
			},
		},
	);
}

/** Path Guard paths usage message. */
export const PATHS_USAGE =
	"Path Guard paths usage:\n" +
	"  /guard paths list | add <path> | rm <path> | clear\n" +
	"  /guard paths protected … (same, explicit — this is the default)\n" +
	"  /guard paths trusted … manage trusted (always-allowed) paths\n\n" +
	"Protected paths are guarded in EVERY mode (including naked).\n" +
	"Trusted paths are ALWAYS allowed (trusted-mode protection for that path);\n" +
	"system-important protected paths (.env/.ssh/keys/…) cannot be trusted.";
/** Path Guard project-config usage message. */
export const PROJECT_USAGE =
	"Path Guard project config usage:\n" +
	" /guard project            show this project's config (file, match, overrides, warnings)\n" +
	" /guard project import     copy a hand-authored .pi/settings.json pathGuard block into it\n" +
	" /guard project remove     delete this project's entry file (asks first)\n" +
	" /guard --project <mode|paths|rules>   save edits to this project instead of globally\n\n" +
	"Project entries live in the pi agent dir (path-guard/projects/), so they are\n" +
	"never mistaken for a trust-requiring project resource.";

/** Everything projectConfigView needs; the live session fills it in by default. */
export interface ProjectViewInput {
	filePath: string;
	projectRoot: string;
	matchedVia: "exact" | "ancestor" | "authored";
	layer: PathGuardLayer;
	warnings: ConfigWarning[];
}

function overrideList(layer: PathGuardLayer): string[] {
	const out: string[] = [];
	if (layer.mode) out.push(`mode = ${layer.mode}`);
	(layer.extraProtected ?? []).forEach((_, i) => out.push(`extraProtected[${i}]`));
	(layer.trustedPaths ?? []).forEach((_, i) => out.push(`trustedPaths[${i}]`));
	for (const [mode, rules] of Object.entries(layer.rules ?? {})) {
		for (const rule of Object.keys(rules ?? {})) out.push(`rules.${mode}.${rule}`);
	}
	return out;
}

/** Human-readable view of a project config (live session when no input given). */
export function projectConfigView(entry?: ProjectViewInput): string {
	const live = getLayers();
	const allWarnings = getConfigWarnings();
	const view: ProjectViewInput | undefined =
		entry ??
		(live.projectFile && live.project
			? {
					filePath: live.projectFile,
					projectRoot: live.projectRoot ?? "",
					matchedVia: live.matchedVia ?? "exact",
					layer: live.project,
					warnings: allWarnings,
				}
			: live.authored
				? {
						filePath: live.authored.file,
						projectRoot: live.authored.root,
						matchedVia: "authored",
						layer: live.authored.layer,
						warnings: allWarnings,
					}
				: undefined);
	const warningLines = (warnings: ConfigWarning[]) => {
		const lines = [`· warnings: ${warnings.length}`];
		for (const warning of warnings.slice(0, 3)) {
			lines.push(
				`  · ${warning.path}${warning.field ? ` ${warning.field}` : ""}: ${warning.message}`,
			);
		}
		if (warnings.length > 3) lines.push(`  · … and ${warnings.length - 3} more`);
		return lines;
	};
	if (!view) {
		// A broken entry has no view — but its warning is exactly what the user was
		// sent here to read, so surface it instead of pretending there is nothing.
		const missing = ["Path Guard project config"];
		missing.push(
			allWarnings.length > 0
				? "· file: (no usable entry — see warnings)"
				: "· file: (none — using global config only)",
		);
		if (allWarnings.length > 0) missing.push(...warningLines(allWarnings));
		missing.push("· create one with: /guard --project <mode>");
		return missing.join("\n");
	}
	const lines = [
		"Path Guard project config",
		`· file: ${view.filePath}`,
		`· match: ${view.matchedVia}`,
		`· project root: ${view.projectRoot}`,
	];
	const overrides = overrideList(view.layer);
	lines.push(
		`· overrides: ${overrides.length > 0 ? overrides.join(", ") : "(none)"}`,
	);
	lines.push(...warningLines(allWarnings));
	if (view.projectRoot && !existsSync(view.projectRoot)) {
		lines.push(
			"· stale — project directory no longer exists (kept until /guard doctor can prune in a later release)",
		);
	}
	return lines.join("\n");
}

/** `/guard project [import|remove]` — manage this project's entry file. */
export async function handleProjectCommand(
	raw: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const rest = raw.replace(/^project\s*/i, "").trim().toLowerCase();
	// Always answer for the current directory: a stale in-memory layer from an
	// earlier cwd would otherwise hide (or overwrite) this project's config.
	if (ctx.cwd) applyConfig(readSavedConfig(ctx.cwd, ctx.isProjectTrusted?.() === true));
	const show = (msg: string) => ctx.ui.notify(msg, "info");
	const warn = (msg: string) => ctx.ui.notify(msg, "warning");

	if (rest === "" || rest === "show" || rest === "list") {
		return show(projectConfigView());
	}

	if (rest === "import") {
		if (!ctx.cwd) return warn("Path Guard: no working directory — nothing to import");
		const source = projectSettingsPath(ctx.cwd) as string;
		const read = readSettingsFile(source);
		if (!read.ok) {
			return warn(`Path Guard: cannot read ${source} — ${read.message}`);
		}
		if (!read.guard) {
			return show(`Path Guard: no pathGuard block in ${source} — nothing to import`);
		}
		if (ctx.isProjectTrusted?.() !== true) {
			return warn(
				`Path Guard: ${source} is project config — approve this project (trust) before importing it`,
			);
		}
		if (getLayers().project) {
			return show(
				`Path Guard: this project already has an entry (${getLayers().projectFile}) — remove it first with /guard project remove`,
			);
		}
		const target = projectEntryPath(ctx.cwd);
		// A repo-supplied trustedPaths list must not become a user-level, permanent
		// allow-list without review: validate every entry and report what changed.
		const layer: PathGuardLayer = { ...read.guard };
		const accepted: string[] = [];
		const refused: string[] = [];
		for (const entry of read.guard.trustedPaths ?? []) {
			const denied = untrustableReason(
				normalizeProtectedEntry(entry, resolveReal(ctx.cwd)),
			);
			if (denied) refused.push(`${entry} (${denied})`);
			else accepted.push(entry);
		}
		if (refused.length > 0) {
			if (accepted.length > 0) layer.trustedPaths = accepted;
			else delete layer.trustedPaths;
		}
		try {
			mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
			writeFileAtomic(
				target,
				`${JSON.stringify(
					{ version: 1, project: ctx.cwd, ...layer, updatedAt: new Date().toISOString() },
					null,
					2,
				)}\n`,
			);
		} catch (e) {
			return warn(
				`Path Guard: could not write ${target} — ${e instanceof Error ? e.message : String(e)}`,
			);
		}
		applyConfig(readSavedConfig(ctx.cwd, true));
		const lines = [`Path Guard: imported the pathGuard block into ${target}`];
		if (accepted.length > 0) {
			lines.push(`· trusted paths imported: ${accepted.join(", ")}`);
		}
		if (refused.length > 0) {
			lines.push(`· refused (protected — cannot be trusted): ${refused.join(", ")}`);
		}
		lines.push(
			`· ${source} still exists — delete its pathGuard block when you are ready`,
		);
		return show(lines.join("\n"));	}

	if (rest === "remove") {
		const live = getLayers();
		if (!live.project || !live.projectFile) {
			return show("Path Guard: this directory has no project config to remove");
		}
		const file = live.projectFile;
		if (!ctx.hasUI) {
			return warn(
				`Path Guard: /guard project remove needs a UI to confirm — delete ${file} manually`,
			);
		}
		const extra =
			live.matchedVia === "ancestor"
				? `\nIt was matched from a parent directory, so this file also applies to every directory under ${live.projectRoot}.`
				: "";
		const ok = await ctx.ui.confirm(
			"Delete this project's config?",
			`File: ${file}${extra}\n\nThe project goes back to the global config on the next session.`,
		);
		if (!ok) return show("Cancelled, project config kept");
		try {
			rmSync(file, { force: true });
		} catch (e) {
			return warn(
				`Path Guard: could not delete ${file} — ${e instanceof Error ? e.message : String(e)}`,
			);
		}
		if (ctx.cwd) applyConfig(readSavedConfig(ctx.cwd, true));
		// Re-derive the effective mode into the footer: applyConfig only updates
		// the in-memory config; the status-bar mirror needs an explicit setMode.
		setMode(getConfig().mode, ctx.ui);
		return show(`Path Guard: removed project config ${file}`);
	}

	return show(PROJECT_USAGE);
}

export async function handlePathsCommand(raw: string, ctx: ExtensionCommandContext) {
	let rest = raw.replace(/^paths\s*/i, "").trim();
	let kind: PathKind = "protected";
	const cat = rest.match(/^(protected|trusted)\b/i);
	if (cat) {
		kind = cat[1].toLowerCase() as PathKind;
		rest = rest.slice(cat[0].length).trim();
	}
	const spaceIdx = rest.indexOf(" ");
	const sub = (spaceIdx === -1 ? rest : rest.slice(0, spaceIdx)).toLowerCase();
	const arg = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1).trim();
	const show = (msg: string) => ctx.ui.notify(msg, "info");
	const list = pathList(kind);

	switch (sub) {
		case "list":
		case "show":
			if (list.length === 0) {
				return show(`Path Guard: no ${kind} paths configured`);
			}
			return show(
				`Path Guard ${kind} paths (${list.length}):\n` +
					list.map((p) => `· ${p}`).join("\n"),
			);
		case "add": {
			if (!arg) return show(`Usage: /guard paths ${kind} add <path>`);
			const norm = normalizeInScope(getWriteScope(), arg);
			if (kind === "trusted") {
				const denied = untrustableReason(norm);
				if (denied) {
					return show(`Path Guard: cannot trust ${norm} — ${denied}`);
				}
				if (!(await confirmTrustPath(ctx))) {
					return show(
						`Path Guard: not added — trusting ${norm} requires confirmation`,
					);
				}
			}
			if (list.includes(norm)) {
				return show(`Path Guard: already ${kind} — ${norm}`);
			}
			return show(actionAddPath(kind, arg, ctx));
		}
		case "rm":
		case "remove": {
			if (!arg) return show(`Usage: /guard paths ${kind} rm <path>`);
			const norm = normalizeInScope(getWriteScope(), arg);
			return show(actionRemovePath(kind, norm, ctx));
		}
		case "clear":
			return show(await confirmClearPaths(kind, ctx));
		default:
			return show(PATHS_USAGE);
	}
}

/** Warning confirmation before adding a trusted path: that path bypasses all path-guard prompts in every mode */
export async function confirmTrustPath(
	ctx: ExtensionCommandContext,
): Promise<boolean> {
	// No UI (headless) cannot confirm → conservatively refuse the trust
	if (!ctx.hasUI) return false;
	return ctx.ui.confirm("⚠️ Trust this path?", TRUST_PATH_WARNING);
}

/** Warning confirmation before switching to trusted: behavior boundary is very loose; requires explicit user confirmation */
export async function confirmTrustedSwitch(
	ctx: ExtensionCommandContext,
): Promise<boolean> {
	// No UI (headless) cannot confirm → conservatively refuse the switch
	if (!ctx.hasUI) return false;
	return ctx.ui.confirm("⚠️ Switch to trusted mode?", TRUSTED_SWITCH_WARNING);
}

/** Double confirmation before switching to naked: disables ALL protection (incl. protected paths, destructive commands, and write/edit checks) */
export async function confirmNakedSwitch(
	ctx: ExtensionCommandContext,
): Promise<boolean> {
	// No UI (headless) cannot confirm → conservatively refuse the switch
	if (!ctx.hasUI) return false;
	const first = await ctx.ui.confirm(
		"⚠️ Switch to NAKED mode?",
		NAKED_SWITCH_WARNING_1,
	);
	if (!first) return false;
	// Second, final confirmation — makes an accidental /guard naked far less likely
	return ctx.ui.confirm(
		"⚠️⚠️ FINAL confirmation — disable ALL protection?",
		NAKED_SWITCH_WARNING_2,
	);
}

/** Mode-switch confirmation: trusted → single warn; naked → double warn; others → no confirmation */
export async function confirmModeSwitch(
	mode: GuardMode,
	ctx: ExtensionCommandContext,
): Promise<boolean> {
	if (mode === "trusted") return confirmTrustedSwitch(ctx);
	if (mode === "naked") return confirmNakedSwitch(ctx);
	return true;
}
