import type { Component, Focusable } from "@earendil-works/pi-tui";
import { Input, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NAKED_SWITCH_WARNING_1, NAKED_SWITCH_WARNING_2, TRUSTED_SWITCH_WARNING, TRUST_PATH_WARNING } from "./constants.ts";
import { DEFAULT_MODES, GUARD_MODES, MODE_DESCRIPTIONS, RULE_DESCRIPTIONS, RULE_IDS, RULE_LEVELS, RULE_LEVEL_LABELS, clearSessionPass, getConfig, getMode, isGuardMode, isRuleLevel, normalizeProtectedEntry, pathList, persistConfig, persistNote, rlFor, sessionPassList, setMode, untrustableReason, type GuardMode, type PathKind, type RuleId, type RuleLevel } from "./rules.ts";

// path-guard — /guard interactive UI: chained menus, actions, rules matrix,
// the single self-contained overlay panel, and warning confirmations.

/** Switch the active mode: update config, refresh the footer, persist. Confirm first. */
export function actionSwitchMode(mode: GuardMode, ctx: ExtensionCommandContext): string {
	getConfig().mode = mode;
	setMode(mode, ctx.ui);
	const where = persistConfig(ctx.cwd);
	return `Path Guard switched to: ${mode} (${persistNote(where)})`;
}

/** Set one rule override for a mode (block/confirm/pass). */
export function actionSetRule(
	mode: GuardMode,
	rule: RuleId,
	level: RuleLevel,
	ctx: ExtensionCommandContext,
): string {
	(getConfig().rules[mode] ??= {})[rule] = level;
	clearSessionPass(mode);
	const where = persistConfig(ctx.cwd);
	return `Path Guard: set ${mode}.${rule} = ${level} (${persistNote(where)})`;
}

/** Reset one rule to its built-in default (drops the override). */
export function actionResetRule(
	mode: GuardMode,
	rule: RuleId,
	ctx: ExtensionCommandContext,
): string {
	if (getConfig().rules[mode]) delete getConfig().rules[mode]![rule];
	clearSessionPass(mode);
	const where = persistConfig(ctx.cwd);
	return `Path Guard: ${mode}.${rule} back to default ${DEFAULT_MODES[mode][rule]} (${persistNote(where)})`;
}

/** Reset every override of one mode to built-in defaults. */
export function actionResetMode(mode: GuardMode, ctx: ExtensionCommandContext): string {
	delete getConfig().rules[mode];
	clearSessionPass(mode);
	const where = persistConfig(ctx.cwd);
	return `Path Guard: reset mode ${mode} to defaults (${persistNote(where)})`;
}

/** Clear all rule overrides for every mode. */
export function actionResetAllRules(ctx: ExtensionCommandContext): string {
	getConfig().rules = {};
	clearSessionPass();
	const where = persistConfig(ctx.cwd);
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
): string {
	const norm = normalizeProtectedEntry(input, ctx.cwd);
	if (kind === "trusted") {
		const denied = untrustableReason(norm);
		if (denied) return `Path Guard: cannot trust ${norm} — ${denied}`;
	}
	const list = pathList(kind);
	if (list.includes(norm)) return `Path Guard: already ${kind} — ${norm}`;
	list.push(norm);
	const where = persistConfig(ctx.cwd);
	return `Path Guard: added ${kind} path ${norm} (${persistNote(where)})`;
}

/** Remove a (normalized) path entry. */
export function actionRemovePath(
	kind: PathKind,
	target: string,
	ctx: ExtensionCommandContext,
): string {
	const list = pathList(kind);
	const idx = list.indexOf(target);
	if (idx === -1) return `Path Guard: not a ${kind} path — ${target}`;
	list.splice(idx, 1);
	const where = persistConfig(ctx.cwd);
	return `Path Guard: removed ${kind} path ${target} (${persistNote(where)})`;
}

/** Clear every entry of a path category. */
export function actionClearPaths(
	kind: PathKind,
	ctx: ExtensionCommandContext,
): string {
	const list = pathList(kind);
	if (list.length === 0) return `Path Guard: no ${kind} paths to clear`;
	list.length = 0;
	const where = persistConfig(ctx.cwd);
	return `Path Guard: cleared all ${kind} paths (${persistNote(where)})`;
}

/**
 * Main /guard menu (shown when invoked with no/unknown args and a UI is
 * available). Extend this array to add future top-level actions.
 */
export const GUARD_MAIN_MENU = [
	"switch — Switch mode (切换防护模式)",
	"rules — Customize per-mode guard rules (定制每模式守护规则)",
	"paths — Manage protected & trusted paths (管理保护/信任路径)",
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

/** Add/remove/clear loop for one path category; "back" returns to the category chooser. */
export async function runPathCategoryMenu(
	kind: PathKind,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const list = pathList(kind);
	while (true) {
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
			if (list.length === 0) {
				ctx.ui.notify(`Path Guard: no ${kind} paths to clear`, "info");
				continue;
			}
			const ok = await ctx.ui.confirm(
				`Clear all ${kind} paths?`,
				`Remove these ${list.length} path(s)?\n` +
					list.map((p) => `· ${p}`).join("\n"),
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
	const cur = rlFor(mode, rule);
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
 * Rule editor for one mode: shows all 17 rules with their current levels, lets
 * the user set several in a row (each level pick returns here), and offers
 * reset (this mode) + back.
 */
export async function runModeEditor(
	mode: GuardMode,
	ctx: ExtensionCommandContext,
): Promise<void> {
	while (true) {
		const title =
			`Mode: ${mode} — pick a rule to set (current levels shown):\n` +
			RULE_IDS.map((r) => `  ${r} = ${rlFor(mode, r)}`).join("\n");
		const options = [
			...RULE_IDS.map((r) => `${r} — ${RULE_DESCRIPTIONS[r]} (${rlFor(mode, r)})`),
			"reset — Reset this mode to built-in defaults (恢复该模式默认)",
			"back — Back to mode list (返回)",
		];
		const picked = await ctx.ui.select(title, options);
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
		if ((RULE_IDS as readonly string[]).includes(op)) {
			await ruleLevelPicker(mode, op as RuleId, ctx);
		}
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
				"Clear ALL rule overrides?",
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
	| { kind: "mode"; idx: number }
	| { kind: "rules"; idx: number }
	| { kind: "ruleMode"; idx: number }
	| { kind: "ruleEditor"; mode: GuardMode; idx: number }
	| { kind: "ruleLevel"; mode: GuardMode; rule: RuleId; idx: number }
	| { kind: "overview"; scroll: number }
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

/** The option labels for a screen; the leading token is the action id. */
export function panelOptions(s: PanelScreen): string[] {
	switch (s.kind) {
		case "main":
			return GUARD_MAIN_MENU;
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
		case "ruleEditor":
			return [
				...RULE_IDS.map(
					(r) => `${r} — ${RULE_DESCRIPTIONS[r]} (${rlFor(s.mode, r)})`,
				),
				"reset — Reset this mode to built-in defaults (恢复该模式默认)",
				"back — Back to mode list (返回)",
			];
		case "ruleLevel":
			return [
				...RULE_LEVELS.map(
					(l) =>
						`${RULE_LEVEL_LABELS[l]}${l === rlFor(s.mode, s.rule) ? " (current)" : ""}${l === DEFAULT_MODES[s.mode][s.rule] ? " [default]" : ""}`,
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
				else if (id === "rules") this.push({ kind: "rules", idx: 0 });
				else if (id === "paths")
					this.push({ kind: "pathsCategory", idx: 0 });
				return;
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
						"Clear ALL rule overrides?",
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
					this.push({ kind: "ruleEditor", mode: id, idx: 0 });
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
			case "ruleEditor": {
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
				else if ((RULE_IDS as readonly string[]).includes(id))
					this.push({
						kind: "ruleLevel",
						mode,
						rule: id as RuleId,
						idx: 0,
					});
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
				if (s.idx >= list.length) {
					this.pop();
					return;
				}
				this.status = actionRemovePath(kind, list[s.idx], this.ctx);
				this.pop();
				return;
			}
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
			else if (matchesKey(data, "pageup") || matchesKey(data, "ctrl+u"))
				s.scroll = Math.max(0, s.scroll - 10);
			else if (matchesKey(data, "pagedown") || matchesKey(data, "ctrl+d"))
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
		if (s.kind === "pathsAdd") return "type a path · ⏎ submit · esc back";
		return `↑/↓ move · ⏎ select · esc back${s.kind === "main" ? " · q quit" : ""}`;
	}

	private renderScreen(s: PanelScreen, width: number): string[] {
		const out: string[] = [];
		switch (s.kind) {
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
			case "ruleEditor":
				out.push(
					`Mode: ${s.mode} — pick a rule to set (current levels shown):`,
				);
				out.push(...this.listLines(panelOptions(s), s.idx, 16));
				break;
			case "ruleLevel":
				out.push(
					`Mode: ${s.mode} · Rule: ${s.rule} — ${RULE_DESCRIPTIONS[s.rule]}`,
				);
				out.push(
					`Current: ${rlFor(s.mode, s.rule)} · Built-in default: ${DEFAULT_MODES[s.mode][s.rule]}`,
					"",
				);
				out.push(...this.listLines(panelOptions(s), s.idx));
				break;
			case "overview":
				out.push(...this.overviewLines(rulesMatrix().split("\n"), s.scroll));
				break;
			case "pathsCategory":
				out.push("Choose a path category:", "");
				out.push(...this.listLines(panelOptions(s), s.idx));
				break;
			case "pathsActions": {
				const list = pathList(s.pathKind);
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
			case "pathsRemove":
				out.push(`Choose a ${s.pathKind} path to remove:`, "");
				out.push(...this.listLines(panelOptions(s), s.idx));
				break;
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
			fg("accent", `Path Guard  ·  mode: ${getMode()}`),
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
			const norm = normalizeProtectedEntry(arg, ctx.cwd);
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
			const norm = normalizeProtectedEntry(arg, ctx.cwd);
			return show(actionRemovePath(kind, norm, ctx));
		}
		case "clear":
			return show(actionClearPaths(kind, ctx));
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
