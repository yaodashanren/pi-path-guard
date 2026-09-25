/**
 * Path Guard Extension — protects against accidental deletes / overwrites / edits
 *
 * Version history lives in CHANGELOG.md (aligned with package.json); the most
 * recent release/tag is 1.6.3.
 */
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionCommandContext,
	BashToolInput,
	EditToolInput,
	WriteToolInput,
	ToolCallEventResult,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
	resolve,
	normalize,
	relative as relativePath,
	join,
	dirname,
	basename,
	sep,
} from "node:path";
import {
	Input,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
} from "@earendil-works/pi-tui";
import {
	realpathSync,
	existsSync,
	statSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { BLOCK_DANGEROUS_PATTERNS, CONFIG_DIR, CONFIRM_DANGEROUS_PATTERNS, DELETE_COMMANDS, DEVICE_TARGETS, EXACT_ONLY_PATTERNS, FLAGS_WITH_ARG, HOME, INPLACE_EDITORS, NAKED_SWITCH_WARNING_1, NAKED_SWITCH_WARNING_2, OVERWRITE_COMMANDS, PIPE_TO_SHELL_SOURCES, PREFIX_COMMANDS, PROTECTED_PATH_PATTERNS, SAFE_CREDENTIAL_SUFFIXES, SHELL_INTERPRETERS, SHELL_WRAPPERS, TRUSTED_SWITCH_WARNING, TRUST_PATH_WARNING } from "./constants.ts";
import { tagged, withEscapeHints } from "./escape.ts";
import { expandHome, isDirectory, isOutsideCwd, isRemoteTarget, isUnresolvedTarget, matchesProtectedPath, resolveReal } from "./paths.ts";
import { applyConfig, SESSION_PASS_EXCLUDED, clearSessionPass, DEFAULT_MODES, getConfig, getMode, GUARD_MODES, MODE_DESCRIPTIONS, inNaked, isGuardMode, isRuleLevel, isSessionPassed, isTrustedPath, isUserProtectedPath, normalizeProtectedEntry, pathList, persistConfig, persistNote, readSavedConfig, RULE_DESCRIPTIONS, RULE_IDS, RULE_LEVELS, RULE_LEVEL_LABELS, rl, rlFor, ruleVerdict, sessionPassList, sessionPassRule, setMode, untrustableReason, type GuardMode, type GuardVerdict, type PathKind, type PathGuardConfig, type RuleId, type RuleLevel } from "./rules.ts";


// ─── Shared /guard actions (single source of truth for the overlay & menus) ──
// Both the interactive overlay panel and the legacy chained menus (plus the
// scriptable /guard paths handler) mutate state through these helpers, so the
// two UI paths can never drift apart.

/** Switch the active mode: update config, refresh the footer, persist. Confirm first. */
function actionSwitchMode(mode: GuardMode, ctx: ExtensionCommandContext): string {
	getConfig().mode = mode;
	setMode(mode, ctx.ui);
	const where = persistConfig(ctx.cwd);
	return `Path Guard switched to: ${mode} (${persistNote(where)})`;
}

/** Set one rule override for a mode (block/confirm/pass). */
function actionSetRule(
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
function actionResetRule(
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
function actionResetMode(mode: GuardMode, ctx: ExtensionCommandContext): string {
	delete getConfig().rules[mode];
	clearSessionPass(mode);
	const where = persistConfig(ctx.cwd);
	return `Path Guard: reset mode ${mode} to defaults (${persistNote(where)})`;
}

/** Clear all rule overrides for every mode. */
function actionResetAllRules(ctx: ExtensionCommandContext): string {
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
function actionAddPath(
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
function actionRemovePath(
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
function actionClearPaths(
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
const GUARD_MAIN_MENU = [
	"switch — Switch mode (切换防护模式)",
	"rules — Customize per-mode guard rules (定制每模式守护规则)",
	"paths — Manage protected & trusted paths (管理保护/信任路径)",
];

/** First step inside /guard paths: pick a category (loops until back/cancel). */
const GUARD_PATHS_CATEGORY_MENU = [
	"protected — Custom protected paths (自定义受保护路径)",
	"trusted — Trusted paths, always allowed (信任路径，始终放行)",
	"back — Back to main menu (返回)",
];

/** Second step: per-category actions (loops until back to the category chooser). */
function pathsActionsMenu(kind: PathKind): string[] {
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
async function runModePicker(ctx: ExtensionCommandContext): Promise<boolean> {
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
async function runPathsMenu(ctx: ExtensionCommandContext): Promise<void> {
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
async function runPathCategoryMenu(
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
const GUARD_RULES_MENU = [
	"mode — Pick a mode to customize (选择要定制的模式)",
	"overview — Show the full mode×rule matrix (查看完整规则矩阵)",
	"reset — Clear ALL rule overrides (清空全部规则覆盖)",
	"back — Back to main menu (返回)",
];

/** Widget id used to render the full effective rules matrix above the editor. */
const OVERVIEW_WIDGET = "path-guard-overview";

/**
 * Show the full rules matrix above the editor. Only used by the legacy chained
 * fallback menus (the overlay renders the matrix in its own overview screen).
 */
async function showMatrixViewer(
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
function rulesMatrix(): string {
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
function rulesSummary(): string {
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
async function ruleLevelPicker(
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
async function runModeEditor(
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
async function runModeSubmenu(ctx: ExtensionCommandContext): Promise<void> {
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
async function runRulesMenu(ctx: ExtensionCommandContext): Promise<void> {
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
type PanelScreen =
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
interface PendingConfirm {
	title: string;
	body: string;
	onConfirm: () => void;
}

/** Minimal theme surface the panel uses (kept loose so test mocks are accepted). */
type PanelTheme = { fg: (color: any, text: string) => string };

/** The option labels for a screen; the leading token is the action id. */
function panelOptions(s: PanelScreen): string[] {
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
function framePanel(inner: string[], width: number): string[] {
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
class GuardPanel implements Component, Focusable {
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
async function runGuardPanel(ctx: ExtensionCommandContext): Promise<void> {
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
const PATHS_USAGE =
	"Path Guard paths usage:\n" +
	"  /guard paths list | add <path> | rm <path> | clear\n" +
	"  /guard paths protected … (same, explicit — this is the default)\n" +
	"  /guard paths trusted … manage trusted (always-allowed) paths\n\n" +
	"Protected paths are guarded in EVERY mode (including naked).\n" +
	"Trusted paths are ALWAYS allowed (trusted-mode protection for that path);\n" +
	"system-important protected paths (.env/.ssh/keys/…) cannot be trusted.";
async function handlePathsCommand(raw: string, ctx: ExtensionCommandContext) {
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


/** Entry point: register event handlers and the /guard command. */
export default function (pi: ExtensionAPI) {
	// Restore the persisted config on every new session (startup, /new, /resume all
	// fire session_start): active mode + user protected paths + rule overrides.
	pi.on("session_start", (_event, ctx) => {
		const cfg = readSavedConfig(ctx.cwd, ctx.isProjectTrusted?.() === true);
		applyConfig(cfg);
		clearSessionPass();
		setMode(cfg.mode, ctx.ui);
		// A persisted loose mode survives into every new session; surface it so the
		// user never runs unprotected without noticing (naked in particular).
		if (cfg.mode === "naked") {
			ctx.ui.notify(
				"⚠️ Path Guard restored in NAKED mode — nearly all protection is OFF " +
					"(persisted from a previous session). Use /guard normal to re-enable.",
				"warning",
			);
		} else if (cfg.mode === "trusted") {
			ctx.ui.notify(
				"⚠️ Path Guard restored in trusted mode (persisted from a previous session): " +
					"in-project deletes and outside overwrites are no longer prompted. " +
					"Use /guard normal to re-enable prompts.",
				"warning",
			);
		}
	});

	// /guard slash command: view / switch mode, and manage custom protected paths
	pi.registerCommand("guard", {
		description:
			"Path Guard: /guard shows mode, /guard <strict|normal|loose|trusted|naked> switches, /guard paths <protected|trusted> list|add|rm|clear",
		handler: async (args, ctx) => {
			const raw = args?.trim() ?? "";
			const m = raw.toLowerCase();

			// ── /guard paths … : manage user-configured protected paths (any mode) ──
			if (m === "paths" || m.startsWith("paths ")) {
				return handlePathsCommand(raw, ctx);
			}

			// Valid argument → switch directly (shortcut, no picker); trusted/naked require a warning confirmation
			if (isGuardMode(m)) {
				if (!(await confirmModeSwitch(m, ctx))) {
					ctx.ui.notify(
						`Cancelled: switching to ${m} requires confirmation`,
						"info",
					);
					return;
				}
				getConfig().mode = m;
				setMode(m, ctx.ui);
				const where = persistConfig(ctx.cwd);
				ctx.ui.notify(
					`Path Guard switched to: ${m} (${persistNote(where)})`,
					"info",
				);
				return;
			}

			// No UI → cannot interact; just show the current mode
			if (!ctx.hasUI) {
				ctx.ui.notify(`Path Guard current mode: ${getMode()}`, "info");
				return;
			}

			// Prefer the single self-contained overlay popup when the host supports
			// custom components; the chained select/confirm menus below remain as a
			// fallback for hosts/mocks that do not implement ctx.ui.custom.
			if (typeof ctx.ui.custom === "function") {
				return runGuardPanel(ctx);
			}

			// Interactive main menu loop (fallback for no/invalid arg): switch mode, manage
			// custom protected paths, or customize per-mode guard rules. Sub-menus return
			// here on "back"; only cancelling at this top level exits the command.
			while (true) {
				const main = await ctx.ui.select(
					`Path Guard — current mode: ${getMode()} — choose an action:`,
					GUARD_MAIN_MENU,
				);
				if (!main) {
					ctx.ui.notify("Cancelled", "info");
					return;
				}
				const option = main.split(/\s+/)[0];
				if (option === "paths") await runPathsMenu(ctx);
				else if (option === "rules") await runRulesMenu(ctx);
				else await runModePicker(ctx);
			}
		},
	});

	pi.on("tool_call", (event, ctx) => {
		// ── write / edit ──────────────────────────────────────────
		if (event.toolName === "write" || event.toolName === "edit") {
			return checkWriteEdit(event.input as WriteToolInput | EditToolInput, ctx);
		}

		// ── bash ────────────────────────────────────────────────
		if (event.toolName === "bash") {
			return checkBashCommand(event.input as BashToolInput, ctx);
		}
	});
}


function checkWriteEdit(
	input: WriteToolInput | EditToolInput,
	ctx: ExtensionContext,
): GuardVerdict {
	const path = input.path;
	if (!path) return;

	// Resolve the real cwd first (cwd may itself be a symlink), then the real target path,
	// preventing symlink escape to protected locations and symlink-cwd false positives
	const realCwd = resolveReal(ctx.cwd);
	const real = resolveReal(resolve(realCwd, expandHome(path)));

	// ① User-configured protected paths are guarded in EVERY mode (incl. naked).
	if (isUserProtectedPath(real)) {
		return {
			block: true,
			reason: withEscapeHints(tagged("userPath", `Path "${real}" is user-protected; write blocked.`)),
		};
	}

	// ② naked passes everything else (built-in protected paths & the write/edit tools).
	if (getMode() === "naked") return;

	// ③ Built-in protected path (incl. HOME-level credentials/config, inside or outside project) → block
	if (matchesProtectedPath(real)) {
		return {
			block: true,
			reason: withEscapeHints(tagged("protectedPath", `Path "${real}" is protected; write blocked.`)),
		};
	}

	// ③b A trusted path is always allowed — protection outranks trust (a trusted
	// entry is never a protected path), so skip the outside/HOME/in-project rules.
	if (isTrustedPath(real)) return;

	const outside = isOutsideCwd(real, realCwd);

	// ④ Outside the project dir OR cwd is HOME → per writeOutside / writeHome rule
	if (outside || realCwd === HOME) {
		const rule = outside ? "writeOutside" : "writeHome";
		const lvl = rl(rule);
		if (lvl === "block") {
			return {
				block: true,
				reason: withEscapeHints(`Write blocked by rule (${rule}): ${real}`),
			};
		}
		if (lvl === "confirm") {
			return askConfirm(
				ctx,
				outside
					? `⚠️ File path is outside the project directory\n\nPath: ${real}\nProject: ${realCwd}`
					: `⚠️ Write operation in HOME directory\n\nPath: ${real}\nHOME: ${HOME}\n\nConfirm write?`,
				[rule],
			);
		}
		return; // pass
	}

	// ⑤ In-project → per writeInProject rule
	const lvl = rl("writeInProject");
	if (lvl === "block") {
		return {
			block: true,
			reason: withEscapeHints(`Write blocked by rule (writeInProject): ${real}`),
		};
	}
	if (lvl === "confirm") {
		return askConfirm(
			ctx,
			`⚠️ strict mode: in-project write operation\n\nPath: ${real}\n\nConfirm write?`,
			["writeInProject"],
		);
	}
	return; // In-project and safe: allow
}

/** bash guard: scan segments then decide once (prevents "rm -rf safe && sudo reboot" segment bypass) */
function checkBashCommand(
	input: BashToolInput,
	ctx: ExtensionContext,
): GuardVerdict {
	const command = input.command ?? "";
	if (!command.trim()) return;

	const realCwd = resolveReal(ctx.cwd);

	// Split by &&, ||, ;, |, newline; check each segment and aggregate results,
	// then decide once — so an early return from the first guarded segment can't skip later ones
	const blockReasons: string[] = [];
	const confirmNeeded: string[] = [];
	const confirmRules = new Set<RuleId>();

	// Dangerous pipe-to-shell (curl … | bash, python -c '…' | sh) — the pipe
	// crosses segments, so scan the raw command before the per-segment loop.
	// Heredoc bodies are executed as script text, so they are extracted first,
	// judged like segments, and removed from the command (otherwise they would
	// misparse as tokens of the intro command).
	const { command: bareCommand, bodies: heredocBodies } = extractHeredocs(
		command,
	);
	for (const body of heredocBodies) {
		for (const line of body.split("\n")) {
			const t = line.trim();
			if (!t) continue;
			const v = classifySegment(t, realCwd, ctx.hasUI);
			if (v.kind === "block") blockReasons.push(`heredoc: ${v.reason}`);
			else if (v.kind === "confirm") {
				confirmNeeded.push(`(heredoc) ${t}`);
				if (v.rule) confirmRules.add(v.rule);
			}
		}
	}
	const pipeVerdict = scanPipeToShell(bareCommand, realCwd);
	if (pipeVerdict.kind === "block") {
		blockReasons.push(pipeVerdict.reason);
	} else if (pipeVerdict.kind === "confirm") {
		confirmNeeded.push(command.trim());
		if (pipeVerdict.rule) confirmRules.add(pipeVerdict.rule);
	}

	for (const seg of splitSegments(bareCommand)) {
		const trimmed = seg.trim();
		if (!trimmed) continue;

		const verdict = classifySegment(trimmed, realCwd, ctx.hasUI);
		if (verdict.kind === "block") {
			blockReasons.push(verdict.reason);
		} else if (verdict.kind === "confirm") {
			confirmNeeded.push(trimmed);
			if (verdict.rule) confirmRules.add(verdict.rule);
		}
	}

	// Aggregate: any hard block → block everything (fail-safe)
	if (blockReasons.length > 0) {
		return {
			block: true,
			reason: withEscapeHints(`Command blocked:\n${blockReasons.join("\n")}`),
		};
	}
	// Segments needing confirmation → one prompt, confirm together
	if (confirmNeeded.length > 0) {
		return askConfirm(
			ctx,
			`⚠️ Commands requiring confirmation\n\n${confirmNeeded
				.map((s) => `· ${s}`)
				.join("\n")}\n\nConfirm execution?`,
			[...confirmRules],
		);
	}
	return; // Safe command: allow
}

/** Verdict for a single segment */
type SegmentVerdict =
	| { kind: "block"; reason: string }
	| { kind: "confirm"; rule?: RuleId }
	| { kind: "pass" };

/** Per-segment check: protected redirect → block; dangerous commands → confirm/block; the rest to sub-judges / wrapper recursion */

/**
 * The script-file target of a `source`/`.` or `<shell-interpreter> script` command,
 * or null if the command is neither. For interpreters, inline-code forms (`-c`) are
 * excluded and only an argument that resolves to an existing file counts.
 */
function scriptTargetOf(cmdInfo: CmdInfo, realCwd: string): string | null {
	const cmd = cmdInfo.command;
	if (cmd === "source" || cmd === ".") {
		return cmdInfo.args.find((a) => !a.startsWith("-")) ?? null;
	}
	if (SHELL_INTERPRETERS.has(cmd)) {
		if (hasShortFlag(cmdInfo.args, "c") || hasLongFlag(cmdInfo.args, "command")) {
			return null; // inline code (bash -c '…') — handled by the shell-wrapper check
		}
		for (const a of cmdInfo.args) {
			if (a.startsWith("-")) continue;
			if (existsSync(resolveReal(resolve(realCwd, expandHome(a))))) return a;
		}
		return null;
	}
	return null;
}

/**
 * The literal remainder of an unresolvable `source`/`.`/interpreter target: the part
 * after a leading `$VAR` / `${VAR}` prefix, or the whole glob pattern. It is often
 * enough to recognise a protected target (`$D/id_rsa`, `$D/.ssh/config`) even though
 * the variable itself cannot be expanded.
 */
function unresolvedScriptTail(target: string): string {
	const m = target.match(
		/^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/,
	);
	return m ? target.slice(m[0].length) : target;
}

/**
 * A `$VAR`-prefixed path cannot be matched against a user-protected entry (those are
 * absolute prefixes), so the literal tail is compared segment-wise against the
 * entries' basenames. Conservative direction: a same-named directory blocks too.
 */
function tailLooksUserProtected(tail: string): boolean {
	if (pathList("protected").length === 0) return false;
	const segs = normalize("/x" + tail)
		.toLowerCase()
		.split(sep)
		.filter(Boolean);
	if (segs.length === 0) return false;
	const names = new Set<string>();
	for (const entry of pathList("protected")) {
		const parts = normalize(resolveReal(entry))
			.toLowerCase()
			.split(sep)
			.filter(Boolean);
		if (parts.length > 0) names.add(parts[parts.length - 1]);
	}
	return segs.some((s) => names.has(s));
}

/**
 * Verdict for a `source`/`.`/interpreter target that cannot be resolved statically
 * (a `$VAR` prefix or a glob). The literal tail is still inspected:
 *   1. user-protected tail → hard block, every mode (the user said "never")
 *   2. built-in protected tail → runScriptProtected (same as a literal target)
 *   3. no literal information at all (bare `$VAR` / bare glob) → conservative confirm
 *   4. otherwise → scriptUnresolved (per-mode ladder: strict block, normal/loose
 *      confirm, trusted/naked pass)
 */
function judgeUnresolvedScriptTarget(target: string): SegmentVerdict {
	const tail = unresolvedScriptTail(target);
	// Nothing but separators / glob metacharacters → no information to act on.
	if (!/[^/*?[\]]/.test(tail)) {
		return inNaked() ? { kind: "pass" } : { kind: "confirm" };
	}
	if (tailLooksUserProtected(tail)) {
		return {
			kind: "block",
			reason: tagged("userPath", `Script execution of user-protected path: ${target}`),
		};
	}
	if (matchesProtectedPath("/__var__" + tail)) {
		return ruleVerdict(
			"runScriptProtected",
			`Script execution blocked by rule (runScriptProtected): ${target}`,
		);
	}
	return ruleVerdict(
		"scriptUnresolved",
		`Script path cannot be resolved statically — confirm (scriptUnresolved): ${target}`,
	);
}

/**
 * Verdict for a redirect write target (`> "$VAR/..."`, `> *.log`) that cannot be
 * resolved statically. The literal tail is still inspected, mirroring the
 * run-script guard:
 *   1. user-protected tail → hard block, every mode (the user said "never")
 *   2. built-in protected tail → hard block (same as a literal redirect target;
 *      still passes in naked, matching the literal-target branch)
 *   3. no literal information at all (bare `$VAR` / bare glob) → conservative confirm
 *   4. otherwise → redirectUnresolved (per-mode ladder: strict block, normal/loose
 *      confirm, trusted/naked pass)
 */
function judgeUnresolvedRedirectTarget(target: string): SegmentVerdict {
	const tail = unresolvedScriptTail(target);
	// Nothing but separators / glob metacharacters → no information to act on.
	if (!/[^/*?[\]]/.test(tail)) {
		return inNaked() ? { kind: "pass" } : { kind: "confirm" };
	}
	if (tailLooksUserProtected(tail)) {
		return {
			kind: "block",
			reason: tagged("userPath", `Redirect writes to user-protected path: ${target}`),
		};
	}
	if (!inNaked() && matchesProtectedPath("/__var__" + tail)) {
		return {
			kind: "block",
			reason: tagged("protectedPath", `Redirect writes to protected path: ${target}`),
		};
	}
	return ruleVerdict(
		"redirectUnresolved",
		`Redirect target cannot be resolved statically — confirm (redirectUnresolved): ${target}`,
	);
}

/**
 * `source`/`.` or shell-interpreter script execution verdict — path-aware + tunable:
 *   - user-protected target → hard block in EVERY mode (incl naked)
 *   - built-in protected target → runScriptProtected rule (strict block / normal,loose confirm / trusted,naked pass)
 *   - trusted target → always pass
 *   - otherwise in-project → runScriptInProject, outside/HOME → runScriptOutside
 */
function judgeScript(
	_trimmed: string,
	cmdInfo: CmdInfo,
	realCwd: string,
): SegmentVerdict {
	const cmd = cmdInfo.command;
	const isSource = cmd === "source" || cmd === ".";
	if (!isSource && !SHELL_INTERPRETERS.has(cmd)) return { kind: "pass" };
	if (
		!isSource &&
		(hasShortFlag(cmdInfo.args, "c") || hasLongFlag(cmdInfo.args, "command"))
	) {
		return { kind: "pass" }; // interpreter inline code — not a script file
	}
	const target = scriptTargetOf(cmdInfo, realCwd);
	if (!target) {
		// `source` with no statically resolvable file → conservative; interpreter with
		// no existing script file → nothing to run → pass.
		return isSource && !inNaked() ? { kind: "confirm" } : { kind: "pass" };
	}
	if (target.startsWith("$") || target.includes("*") || target.includes("?")) {
		return judgeUnresolvedScriptTarget(target);
	}
	const real = resolveReal(resolve(realCwd, expandHome(target)));

	// User-configured protected paths stay a hard block in every mode (incl naked).
	if (isUserProtectedPath(real)) {
		return {
			kind: "block",
			reason: tagged("userPath", `Script execution of user-protected path: ${target}`),
		};
	}
	// Built-in protected paths → per-mode ladder (runScriptProtected).
	if (matchesProtectedPath(real)) {
		return ruleVerdict(
			"runScriptProtected",
			`Script execution blocked by rule (runScriptProtected): ${target}`,
		);
	}
	// Trusted path → always allowed.
	if (isTrustedPath(real)) return { kind: "pass" };

	return judgeScriptTargetPath(real, target, realCwd);
}

/**
 * Shared verdict ladder for executing the script file at `real` (used by
 * `judgeScript` for argument targets and `judgeInputRedirect` for `< file`):
 * user-protected → hard block, built-in protected → runScriptProtected,
 * trusted → pass, otherwise runScriptOutside / runScriptInProject.
 */
function judgeScriptTargetPath(
	real: string,
	target: string,
	realCwd: string,
): SegmentVerdict {
	const rule =
		isOutsideCwd(real, realCwd) || realCwd === HOME
			? "runScriptOutside"
			: "runScriptInProject";
	return ruleVerdict(rule, `Script execution blocked by rule (${rule}): ${target}`);
}

/** Input-redirect operand of a command (`sh < file` → "file"), or null. */
function inputRedirectTarget(args: string[]): string | null {
	for (let i = 0; i < args.length - 1; i++) {
		if (args[i] === "<" || args[i] === "0<") return args[i + 1];
	}
	return null;
}

/**
 * `sh < script.sh` executes the file as the interpreter's stdin script — same
 * protection ladder as an argument target. Unresolved (`$VAR`/glob) targets and
 * non-existing/directory targets are left to the other judges / pass.
 */
function judgeInputRedirect(
	_trimmed: string,
	cmdInfo: CmdInfo,
	realCwd: string,
): SegmentVerdict {
	if (!SHELL_INTERPRETERS.has(cmdInfo.command)) return { kind: "pass" };
	const target = inputRedirectTarget(cmdInfo.args);
	if (!target || isUnresolvedTarget(target)) return { kind: "pass" };
	const real = resolveReal(resolve(realCwd, expandHome(target)));
	if (!existsSync(real) || isDirectory(real)) return { kind: "pass" };
	if (isUserProtectedPath(real)) {
		return {
			kind: "block",
			reason: tagged("userPath", `Script execution of user-protected path: ${target}`),
		};
	}
	if (matchesProtectedPath(real)) {
		return ruleVerdict(
			"runScriptProtected",
			`Script execution blocked by rule (runScriptProtected): ${target}`,
		);
	}
	if (isTrustedPath(real)) return { kind: "pass" };
	return judgeScriptTargetPath(real, target, realCwd);
}

/**
 * Extract command substitutions (`$(...)` and backticks) from a command segment.
 * Substitutions inside single quotes are literal, so they are skipped. Nested
 * `$()` bodies are returned whole and handled by the recursive call.
 */
function extractCommandSubstitutions(input: string): string[] {
	const results: string[] = [];
	let i = 0;
	let inSingle = false;
	let inDouble = false;
	while (i < input.length) {
		const ch = input[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			i++;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			i++;
			continue;
		}
		if (inSingle) {
			i++;
			continue;
		}
		// Backtick substitution
		if (ch === "`") {
			const end = input.indexOf("`", i + 1);
			if (end < 0) {
				results.push(input.slice(i + 1));
				break;
			}
			results.push(input.slice(i + 1, end));
			i = end + 1;
			continue;
		}
		// Process substitution <(cmd) / >(cmd) — the inner command runs
		// immediately, so judge its body like a command substitution
		if ((ch === "<" || ch === ">") && input[i + 1] === "(") {
			const close = findMatchingParen(input, i + 1);
			if (close < 0) {
				results.push(input.slice(i + 2));
				break;
			}
			results.push(input.slice(i + 2, close));
			i = close;
			continue;
		}
		// $( ... ) — balanced, quote-aware; `$((` arithmetic is left to the parser
		if (ch === "$" && input[i + 1] === "(" && input[i + 2] !== "(") {
			const j = findMatchingParen(input, i + 1);
			if (j < 0) {
				results.push(input.slice(i + 2));
				break;
			}
			results.push(input.slice(i + 2, j));
			i = j + 1;
			continue;
		}
		i++;
	}
	return results;
}

/**
 * Index of the ")" matching the "(" at openIdx (quote- and escape-aware), or -1.
 */
function findMatchingParen(input: string, openIdx: number): number {
	let depth = 0;
	let sq = false;
	let dq = false;
	for (let j = openIdx; j < input.length; j++) {
		const c = input[j];
		if (c === "\\") {
			j++;
			continue;
		}
		if (c === "'" && !dq) {
			sq = !sq;
			continue;
		}
		if (c === '"' && !sq) {
			dq = !dq;
			continue;
		}
		if (sq) continue;
		if (c === "(") depth++;
		else if (c === ")") {
			depth--;
			if (depth === 0) return j;
		}
	}
	return -1;
}

/**
 * Judge the inner command(s) of command substitutions. Each body may itself be a
 * compound command, so split it and aggregate (block > confirm > pass).
 */
function classifySubstitutions(
	substitutions: string[],
	realCwd: string,
	hasUI: boolean,
	depth: number,
): SegmentVerdict {
	const blockReasons: string[] = [];
	let confirm = false;
	for (const body of substitutions) {
		for (const seg of splitSegments(body)) {
			const s = seg.trim();
			if (!s) continue;
			const v = classifySegment(s, realCwd, hasUI, depth);
			if (v.kind === "block") blockReasons.push(v.reason);
			else if (v.kind === "confirm") confirm = true;
		}
	}
	if (blockReasons.length > 0) {
		return { kind: "block", reason: blockReasons.join("\n") };
	}
	if (confirm) return { kind: "confirm" };
	return { kind: "pass" };
}

/**
 * A command segment: recurse into any `$()` / backtick substitutions, then judge
 * the outer command. A hard block in a substitution wins; a confirm is deferred
 * until the outer verdict is known (block > confirm).
 */
function classifySegment(
	trimmed: string,
	realCwd: string,
	hasUI: boolean,
	depth = 0,
): SegmentVerdict {
	// Recursion depth guard (nested bash -c / eval / $() too deep to statically check → conservative confirm)
	if (depth > 4) return { kind: "confirm" };

	// ⓪ Command substitutions run before the outer command, so judge their content
	//    too — `echo "$(rm -rf x)"` must not slip through.
	const substitutions = extractCommandSubstitutions(trimmed);
	let subConfirm = false;
	if (substitutions.length > 0) {
		const subVerdict = classifySubstitutions(
			substitutions,
			realCwd,
			hasUI,
			depth + 1,
		);
		if (subVerdict.kind === "block") {
			return {
				kind: "block",
				reason: `Command substitution blocked:\n${subVerdict.reason}`,
			};
		}
		if (subVerdict.kind === "confirm") subConfirm = true;
	}

	const outer = classifySegmentOuter(trimmed, realCwd, hasUI, depth);
	if (outer.kind === "block") return outer;
	if (outer.kind === "confirm" || subConfirm) {
		// Preserve the rule id when the outer verdict is rule-driven (enables the
		// confirm dialog's session-pass option); a substitution-only confirm has none.
		return {
			kind: "confirm",
			rule: outer.kind === "confirm" ? outer.rule : undefined,
		};
	}
	return { kind: "pass" };
}

/** Judge one command segment (redirect / danger / wrapper / script / writers). */
function classifySegmentOuter(
	trimmed: string,
	realCwd: string,
	hasUI: boolean,
	depth = 0,
): SegmentVerdict {
	// ① Redirect check:
	//    - Write to a protected path (echo x > .env etc.) → block in every mode (user paths too)
	//    - "> existing file" (truncate, not >> append, not a device) → per truncate rule
	const redirect = extractRedirectTarget(trimmed);
	if (redirect) {
		// Variable/glob target can't be statically resolved (echo x > $F): inspect
		// the literal tail, then follow the redirectUnresolved rule (per-mode).
		if (isUnresolvedTarget(redirect.target)) {
			return judgeUnresolvedRedirectTarget(redirect.target);
		}
		// Direct write to a block device (/dev/sda, /dev/rdiskN, …) — system-
		// destructive, must outrank the writeOutside ladder below (which would
		// only confirm).
		if (
			/^\/dev\/(?!null\b|zero\b|tty\b|stdin\b|stdout\b|stderr\b|pts\b|ptmx\b|full\b|random\b|urandom\b|fuse\b|shm\b)[a-z0-9]+/.test(
				redirect.target,
			)
		) {
			return ruleVerdict(
				"blockGroup",
				`Direct write to a block device blocked: ${trimmed}`,
			);
		}
		const real = resolveReal(resolve(realCwd, expandHome(redirect.target)));
		if (isUserProtectedPath(real)) {
			return {
				kind: "block",
				reason: tagged("userPath", `Redirect writes to user-protected path: ${trimmed}`),
			};
		}
		if (!inNaked() && matchesProtectedPath(real)) {
			return {
				kind: "block",
				reason: tagged("protectedPath", `Redirect writes to protected path: ${trimmed}`),
			};
		}
		// Redirect into a trusted path (incl. truncating it) → pass in every mode.
		if (isTrustedPath(real)) return { kind: "pass" };
		if (
			isTruncatingOp(redirect.op) &&
			!DEVICE_TARGETS.has(redirect.target) &&
			existsSync(real)
		) {
			const rule =
				isOutsideCwd(real, realCwd) || realCwd === HOME
					? "truncateOutside"
					: "truncateInProject";
			return ruleVerdict(rule, `Truncate blocked by rule: ${trimmed}`);
		}
		// New/append target outside the project (or cwd is HOME) → per writeOutside / writeHome
		if (!DEVICE_TARGETS.has(redirect.target)) {
			const outside = isOutsideCwd(real, realCwd);
			if (outside || realCwd === HOME) {
				const rule = outside ? "writeOutside" : "writeHome";
				return ruleVerdict(
					rule,
					`Redirect writes outside the project blocked by rule: ${trimmed}`,
				);
			}
		}
	}

	// ② Dangerous commands → per blockGroup / confirmGroup rule
	const danger = dangerousLevel(trimmed);
	if (danger === "block") {
		return ruleVerdict(
			"blockGroup",
			`System-destructive command blocked: ${trimmed}`,
		);
	}
	if (danger === "confirm") {
		const lvl = rl("confirmGroup");
		if (lvl === "block") {
			return {
				kind: "block",
				reason: `Dangerous command blocked by rule: ${trimmed}`,
			};
		}
		if (lvl === "confirm") {
			return hasUI
				? { kind: "confirm" }
				: {
						kind: "block",
						reason: tagged("noUi", `Dangerous command blocked (no interactive UI): ${trimmed}`),
					};
		}
		return { kind: "pass" }; // confirmGroup = pass
	}

	const cmdInfo = parseCommand(trimmed);
	if (!cmdInfo) return { kind: "pass" };

	// ⓪b The command name itself is unresolved ($VAR left after prefix stripping):
	// statically unknowable → per commandNameUnresolved rule (strict block,
	// normal/loose confirm, trusted/naked pass).
	if (cmdInfo.command.includes("$")) {
		return ruleVerdict(
			"commandNameUnresolved",
			`Command name cannot be resolved statically — confirm (commandNameUnresolved): ${trimmed}`,
		);
	}

	// ③ Shell wrapper (bash -c 'code' / eval 'code') → recursively check the inner code
	const wrapperVerdict = judgeShellWrapper(
		trimmed,
		cmdInfo,
		realCwd,
		hasUI,
		depth,
	);
	if (wrapperVerdict.kind !== "pass") return wrapperVerdict;

	// ④ source / . / <shell> script.sh: runs a script file → path-aware + tunable
	const scriptVerdict = judgeScript(trimmed, cmdInfo, realCwd);
	if (scriptVerdict.kind !== "pass") return scriptVerdict;

	// ④b `sh < script.sh` — an input redirect feeds the file as the interpreter's
	// stdin script, which executes it just like `sh script.sh` → same ladder.
	const inputRedirectVerdict = judgeInputRedirect(trimmed, cmdInfo, realCwd);
	if (inputRedirectVerdict.kind !== "pass") return inputRedirectVerdict;

	// ⑤-⑪ Pipeline for target-writing commands (git / dd / download / truncate / in-place edit / delete / overwrite / unzip -o)
	return judgeWriters(trimmed, cmdInfo, realCwd);
}

/** Shell wrapper verdict: recursively run the same checks on bash -c / eval inner code */
function judgeShellWrapper(
	_trimmed: string,
	cmdInfo: CmdInfo,
	realCwd: string,
	hasUI: boolean,
	depth: number,
): SegmentVerdict {
	const inner = unwrapShellWrapper(cmdInfo);
	if (!inner) return { kind: "pass" };

	// A pipe-to-shell inside the wrapper (bash -c 'curl … | bash') crosses the
	// inner split segments, so scan it before recursing.
	const pipeVerdict = scanPipeToShell(inner, realCwd);
	if (pipeVerdict.kind === "block") {
		return {
			kind: "block",
			reason: `Inner command blocked:\n${pipeVerdict.reason}`,
		};
	}
	if (pipeVerdict.kind === "confirm") return { kind: "confirm" };

	const blockReasons: string[] = [];
	const confirmNeeded: string[] = [];
	for (const seg of splitSegments(inner)) {
		const s = seg.trim();
		if (!s) continue;
		const v = classifySegment(s, realCwd, hasUI, depth + 1);
		if (v.kind === "block") blockReasons.push(v.reason);
		else if (v.kind === "confirm") confirmNeeded.push(s);
	}
	if (blockReasons.length > 0) {
		return {
			kind: "block",
			reason: `Inner command blocked:\n${blockReasons.join("\n")}`,
		};
	}
	if (confirmNeeded.length > 0) return { kind: "confirm" };
	return { kind: "pass" };
}

/** Target-writing pipeline: judge each; return on the first non-pass; allow only when all pass */
function judgeWriters(
	trimmed: string,
	cmdInfo: CmdInfo,
	realCwd: string,
): SegmentVerdict {
	const pipeline: Array<(t: string, c: CmdInfo, r: string) => SegmentVerdict> = [
		judgeGit,
		judgeDd,
		judgeDownload,
		judgeTruncate,
		judgeInPlace,
		judgeDelete,
		judgeOverwrite,
	];
	for (const judge of pipeline) {
		const v = judge(trimmed, cmdInfo, realCwd);
		if (v.kind !== "pass") return v;
	}
	// Archive extraction (unzip / tar -x): archive contents are unknowable, so
	// anything it lands on may be overwritten → conservative confirm (pass in
	// naked). unzip without -o would prompt interactively and stall a
	// non-interactive run — same treatment.
	if (
		cmdInfo.command === "unzip" ||
		(cmdInfo.command === "tar" && tarIsExtraction(cmdInfo.args))
	) {
		return inNaked() ? { kind: "pass" } : { kind: "confirm" };
	}
	return { kind: "pass" };
}

/** Whether tar args express an extraction (that writes files), not a create/list */
function tarIsExtraction(args: string[]): boolean {
	let extract = false;
	let create = false;
	let list = false;
	for (const a of args) {
		if (a === "--extract" || a === "--get") extract = true;
		if (a === "--create" || a === "--append" || a === "--update") create = true;
		if (a === "--list") list = true;
		if (a.startsWith("--")) continue;
		if (a.startsWith("-")) {
			const flags = a.slice(1);
			if (flags.includes("x")) extract = true;
			if (flags.includes("c") || flags.includes("r") || flags.includes("u"))
				create = true;
			if (flags.includes("t")) list = true;
		}
	}
	return extract && !create && !list;
}

/** git destructive commands: clean -f / reset --hard / checkout -- . / restore . / branch -D / push --force / stash drop */
function judgeGit(
	_trimmed: string,
	cmdInfo: CmdInfo,
	_realCwd: string,
): SegmentVerdict {
	if (cmdInfo.command !== "git") return { kind: "pass" };

	const args = cmdInfo.args;
	// Skip git global options (-C dir / -c key=val / --git-dir= etc.), find the subcommand
	let i = 0;
	while (i < args.length) {
		const a = args[i];
		if (a === "-C" || a === "-c") {
			i += 2;
			continue;
		}
		if (
			a.startsWith("--git-dir=") ||
			a.startsWith("--work-tree=") ||
			a === "--bare" ||
			a === "--no-pager" ||
			a === "--paginate"
		) {
			i++;
			continue;
		}
		break;
	}
	const sub = args[i];

	// Destructive git ops → per gitDestructive rule (block / confirm / pass)
	if (sub === "clean" && hasForceFlag(args))
		return ruleVerdict("gitDestructive", "git clean --force blocked by rule");
	if (sub === "reset" && args.includes("--hard"))
		return ruleVerdict("gitDestructive", "git reset --hard blocked by rule");
	if (
		(sub === "checkout" || sub === "switch") &&
		(args.includes("--") || args.includes(".") || hasForceFlag(args))
	)
		return ruleVerdict(
			"gitDestructive",
			"git checkout destructive blocked by rule",
		);
	// `git restore` writes the working tree. Only a whole-tree restore (`.`) counts
	// as destructive; `--source=<ref> -- <path>` is a routine operation and must
	// not trigger on its own. `--staged`-only restores touch the index, not files.
	if (sub === "restore") {
		const stagedOnly =
			(args.includes("--staged") || args.includes("-S")) &&
			!args.includes("--worktree") &&
			!args.includes("-W");
		if (!stagedOnly && args.includes("."))
			return ruleVerdict(
				"gitDestructive",
				"git restore destructive blocked by rule",
			);
	}
	if (sub === "branch" && args.some((a) => a === "-D"))
		return ruleVerdict("gitDestructive", "git branch -D blocked by rule");
	if (sub === "worktree" && args.includes("remove") && hasForceFlag(args))
		return ruleVerdict(
			"gitDestructive",
			"git worktree remove --force blocked by rule",
		);
	if (sub === "tag" && (args.includes("-d") || args.includes("--delete")))
		return ruleVerdict("gitDestructive", "git tag -d blocked by rule");
	if (
		sub === "push" &&
		args.some((a) => a === "-f" || a === "--force" || a === "--force-with-lease")
	)
		return ruleVerdict("gitDestructive", "git push --force blocked by rule");
	if (sub === "stash" && (args.includes("drop") || args.includes("clear")))
		return ruleVerdict("gitDestructive", "git stash drop blocked by rule");
	if (sub === "filter-branch" || sub === "filter-repo")
		return ruleVerdict("gitDestructive", "git history rewrite blocked by rule");

	return { kind: "pass" };
}

/** Delete-command verdict (rm, rmdir, shred, ...); non-delete commands → pass */
function judgeDelete(
	trimmed: string,
	cmdInfo: CmdInfo,
	realCwd: string,
): SegmentVerdict {
	if (!isDeleteCommand(cmdInfo.command)) return { kind: "pass" };

	// Query forms (command -v rm / rm --version etc., no path args) → pass
	if (
		cmdInfo.args.every((a) => a.startsWith("-")) &&
		/(-v|-V|--version|-h|--help)\b/.test(trimmed)
	) {
		return { kind: "pass" };
	}

	const pathArgs = extractPathArgs(cmdInfo.args, realCwd);

	// Protected paths first: user paths block in EVERY mode (incl. naked); built-in paths block except in naked
	for (const p of pathArgs) {
		if (isUserProtectedPath(p.path)) {
			return {
				kind: "block",
				reason: tagged("userPath", `Delete command targets user-protected path: ${p.path}`),
			};
		}
		if (!inNaked() && matchesProtectedPath(p.path)) {
			return {
				kind: "block",
				reason: `Delete command targets protected path: ${p.path}`,
			};
		}
	}

	// No concrete path (rm "$HOME/.ssh", rm ./* — variable/wildcard, not statically resolvable) → conservative confirm (pass in naked)
	if (pathArgs.length === 0) {
		return inNaked() ? { kind: "pass" } : { kind: "confirm" };
	}

	// All concrete targets are trusted → pass in every mode (trusted-mode protection for those paths)
	if (pathArgs.every((p) => isTrustedPath(p.path))) {
		return { kind: "pass" };
	}

	const externalPaths = pathArgs.filter((p) => p.isOutside);
	if (externalPaths.length > 0) {
		const list = externalPaths.map((p) => p.path).join(", ");
		// per deleteOutside rule: strict/normal block, loose confirm, trusted/naked pass
		return ruleVerdict(
			"deleteOutside",
			`Delete command targets paths outside the project directory: ${list}`,
		);
	}

	// In-project delete → per deleteInProject rule (strict/normal confirm; loose/trusted/naked pass)
	return ruleVerdict("deleteInProject", "Delete command blocked by rule");
}

/**
 * Overwrite-command verdict (mv/cp/install/tee/ln -f/rsync):
 *   - Target hits a protected path → block
 *   - Target exists (file, or dir with a basename conflict) → confirm in-project / block outside
 *   - Target missing → confirm outside write / pass in-project (pure rename/create)
 *   - -n/--no-clobber (explicit no-overwrite), ln without -f, tee -a (append) → pass
 */
function judgeOverwrite(
	_trimmed: string,
	cmdInfo: CmdInfo,
	realCwd: string,
): SegmentVerdict {
	if (!OVERWRITE_COMMANDS.has(cmdInfo.command)) return { kind: "pass" };

	// ln only overwrites existing targets with -f/--force
	if (cmdInfo.command === "ln" && !hasForceFlag(cmdInfo.args)) {
		return { kind: "pass" };
	}
	// -n/--no-clobber: explicit no-overwrite, safe to pass
	if (cmdInfo.args.includes("-n") || cmdInfo.args.includes("--no-clobber")) {
		return { kind: "pass" };
	}
	// tee -a / --append: append, no overwrite
	if (
		cmdInfo.command === "tee" &&
		(cmdInfo.args.includes("-a") || cmdInfo.args.includes("--append"))
	) {
		return { kind: "pass" };
	}
	// rsync --delete: removes extra files in the target dir → conservative confirm (pass in naked)
	if (cmdInfo.command === "rsync" && cmdInfo.args.includes("--delete")) {
		return inNaked() ? { kind: "pass" } : { kind: "confirm" };
	}

	// Resolve target: -t dir src... form vs the regular form (last operand is the target)
	let target: string | null = null;
	let sources: string[] = [];
	const tIdx = cmdInfo.args.indexOf("-t");
	if (tIdx >= 0 && cmdInfo.args[tIdx + 1]) {
		target = cmdInfo.args[tIdx + 1];
		sources = cmdInfo.args.filter((a) => !a.startsWith("-") && a !== target);
	} else {
		const operands = cmdInfo.args.filter((a) => !a.startsWith("-"));
		if (operands.length >= 2) {
			target = operands[operands.length - 1];
			sources = operands.slice(0, -1);
		}
	}
	if (!target || sources.length === 0) return { kind: "pass" };

	// Variable/wildcard not statically resolvable → conservative confirm (pass in naked)
	if (isUnresolvedTarget(target)) return unresolvedTargetVerdict();
	// rsync/scp remote target (user@host:/path) is not a local path — resolving it
	// would fake an in-project path. Writing to a remote host → conservative confirm.
	if (isRemoteTarget(target)) {
		return unresolvedTargetVerdict();
	}

	const real = resolveReal(resolve(realCwd, expandHome(target)));
	// ① Target hits a protected path → block (user paths in every mode; built-in except naked)
	const blocked = protectedVerdict(
		real,
		`Command may overwrite user-protected path: ${cmdInfo.command} ${target}`,
		`Command may overwrite protected path: ${cmdInfo.command} ${target}`,
	);
	if (blocked) return blocked;

	// Overwrite/rename target is inside a trusted path → pass (no prompt in any mode).
	if (isTrustedPath(real)) return { kind: "pass" };

	const outside = isOutsideCwd(real, realCwd);

	// Outside overwrite of an existing target → per overwriteOutsideExisting rule
	const outsideOverwriteVerdict = (): SegmentVerdict =>
		ruleVerdict(
			"overwriteOutsideExisting",
			`Command will overwrite a target outside the project directory: ${cmdInfo.command} ${target}`,
		);

	// ② Target is an existing directory: check each source basename for conflicts
	if (existsSync(real) && isDirectory(real)) {
		const conflict = sources.some((s) => {
			// Source not statically resolvable → treat as a conflict
			if (s.startsWith("$") || s.includes("*") || s.includes("?")) return true;
			const srcReal = resolveReal(resolve(realCwd, expandHome(s)));
			return existsSync(join(real, basename(srcReal)));
		});
		if (!conflict) return { kind: "pass" };
		// Overwriting an existing target: outside per overwriteOutsideExisting; in-project per overwriteInProject
		return outside
			? outsideOverwriteVerdict()
			: ruleVerdict("overwriteInProject", "Overwrite in project blocked by rule");
	}

	// ③ Target is an existing file: will be overwritten
	if (existsSync(real)) {
		return outside
			? outsideOverwriteVerdict()
			: ruleVerdict("overwriteInProject", "Overwrite in project blocked by rule");
	}

	// ④ Target missing: outside → per overwriteOutsideNew; in-project → per writeInProject (strict confirm, others pass)
	if (outside) {
		return ruleVerdict(
			"overwriteOutsideNew",
			`Write outside the project blocked by rule: ${cmdInfo.command} ${target}`,
		);
	}
	return ruleVerdict("writeInProject", "Write in project blocked by rule");
}

/** Unwrap a shell wrapper: bash/sh/zsh -c 'code', eval 'code' → inner code; else null */
function unwrapShellWrapper(cmdInfo: CmdInfo): string | null {
	if (SHELL_WRAPPERS.has(cmdInfo.command)) {
		for (let i = 0; i < cmdInfo.args.length; i++) {
			const a = cmdInfo.args[i];
			if (a === "--") break; // everything after is not a flag
			// short flag contains c (-c, -ec combos); long flags don't count
			if (a.startsWith("-") && !a.startsWith("--") && a.includes("c")) {
				const inner = cmdInfo.args.slice(i + 1).join(" ");
				return inner.trim() || null;
			}
		}
		return null;
	}
	if (cmdInfo.command === "eval") {
		const inner = cmdInfo.args.join(" ");
		return inner.trim() || null;
	}
	return null;
}

/** Whether args contain a short flag (supports -i.bak / -pi combos; single-dash only) */
function hasShortFlag(args: string[], ch: string): boolean {
	return args.some(
		(a) => a.startsWith("-") && !a.startsWith("--") && a.slice(1).includes(ch),
	);
}

/** Whether args contain a long flag (--name or --name=value) */
function hasLongFlag(args: string[], name: string): boolean {
	return args.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
}

/** dd verdict: of= pointing at a protected file → block (block-device writes covered by dangerous patterns) */
function judgeDd(
	trimmed: string,
	cmdInfo: CmdInfo,
	realCwd: string,
): SegmentVerdict {
	if (cmdInfo.command !== "dd") return { kind: "pass" };
	for (const a of cmdInfo.args) {
		if (!a.startsWith("of=")) continue;
		const target = a.slice(3);
		if (!target) continue;
		if (isUnresolvedTarget(target)) return unresolvedTargetVerdict();
		const real = resolveReal(resolve(realCwd, expandHome(target)));
		const blocked = protectedVerdict(
			real,
			`dd writes to user-protected path: ${trimmed}`,
			`dd writes to protected path: ${trimmed}`,
		);
		if (blocked) return blocked;
		if (isTrustedPath(real)) continue;
		const outside = outsideWriteVerdict(real, target, realCwd, `dd writes outside the project blocked by rule: ${trimmed}`);
		if (outside) return outside;
	}
	return { kind: "pass" };
}

/** curl/wget verdict: output target hits a protected path → block */
function judgeDownload(
	_trimmed: string,
	cmdInfo: CmdInfo,
	realCwd: string,
): SegmentVerdict {
	if (cmdInfo.command !== "curl" && cmdInfo.command !== "wget") {
		return { kind: "pass" };
	}
	const target = downloadTarget(cmdInfo.command, cmdInfo.args);
	if (!target) return { kind: "pass" };
	if (isUnresolvedTarget(target)) return unresolvedTargetVerdict();
	const real = resolveReal(resolve(realCwd, expandHome(target)));
	const blocked = protectedVerdict(
		real,
		`Download writes to user-protected path: ${cmdInfo.command} ${target}`,
		`Download writes to protected path: ${cmdInfo.command} ${target}`,
	);
	if (blocked) return blocked;
	if (isTrustedPath(real)) return { kind: "pass" };
	return (
		outsideWriteVerdict(
			real,
			target,
			realCwd,
			`Download writes outside the project blocked by rule: ${cmdInfo.command} ${target}`,
		) ?? { kind: "pass" }
	);
}

/** Shared: unresolved target → conservative confirm (pass in naked) */
function unresolvedTargetVerdict(): SegmentVerdict {
	return inNaked() ? { kind: "pass" } : { kind: "confirm" };
}

/** Shared first legs of the per-target verdict chain: user-protected → block in
 *  every mode; built-in protected → block except naked. Returns the block
 *  verdict, or null when the caller should apply its own trusted/outside legs. */
function protectedVerdict(
	real: string,
	userMsg: string,
	protectedMsg: string,
): SegmentVerdict | null {
	if (isUserProtectedPath(real)) {
		return { kind: "block", reason: tagged("userPath", userMsg) };
	}
	if (!inNaked() && matchesProtectedPath(real)) {
		return { kind: "block", reason: tagged("protectedPath", protectedMsg) };
	}
	return null;
}

/** Shared outside leg (dd / download): device targets skip; outside target →
 *  overwriteOutsideExisting / overwriteOutsideNew. Null when not applicable. */
function outsideWriteVerdict(
	real: string,
	rawTarget: string,
	realCwd: string,
	describe: string,
): SegmentVerdict | null {
	if (DEVICE_TARGETS.has(rawTarget)) return null;
	if (!isOutsideCwd(real, realCwd)) return null;
	const rule = existsSync(real)
		? "overwriteOutsideExisting"
		: "overwriteOutsideNew";
	return ruleVerdict(rule, describe);
}

/** Extract the download output target; null if none explicit */
function downloadTarget(command: string, args: string[]): string | null {
	return command === "wget"
		? wgetDownloadTarget(args)
		: curlDownloadTarget(args);
}

/** wget output target (-O / --output / --output-document all take an argument) */
function wgetDownloadTarget(args: string[]): string | null {
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "-O" || a === "--output" || a === "--output-document") {
			return args[i + 1] ?? null;
		}
		if (a.startsWith("--output=") || a.startsWith("--output-document=")) {
			return a.slice(a.indexOf("=") + 1);
		}
	}
	return null;
}

/** curl output target (-o / --output take an argument; -O has none, uses the URL basename) */
function curlDownloadTarget(args: string[]): string | null {
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "-o" || a === "--output" || a === "--output-document") {
			return args[i + 1] ?? null;
		}
		if (a.startsWith("--output=") || a.startsWith("--output-document=")) {
			return a.slice(a.indexOf("=") + 1);
		}
		if (a === "-O") {
			for (let j = i + 1; j < args.length; j++) {
				const u = args[j];
				if (u.startsWith("-")) continue;
				const base = u.split("/").pop();
				if (base) return base;
				break;
			}
		}
	}
	return null;
}

/** truncate verdict: target hits a protected path → block; existing non-device target → confirm */
function judgeTruncate(
	_trimmed: string,
	cmdInfo: CmdInfo,
	realCwd: string,
): SegmentVerdict {
	if (cmdInfo.command !== "truncate") return { kind: "pass" };
	// Any target not statically resolvable (variable/wildcard) → conservative confirm (pass in naked)
	if (
		cmdInfo.args.some(
			(a) =>
				!a.startsWith("-") &&
				(a.startsWith("$") || a.includes("*") || a.includes("?")),
		)
	) {
		return inNaked() ? { kind: "pass" } : { kind: "confirm" };
	}
	for (const t of extractPathArgs(cmdInfo.args, realCwd)) {
		const blocked = protectedVerdict(
			t.path,
			`truncate truncates user-protected path: ${t.raw}`,
			`truncate truncates protected path: ${t.raw}`,
		);
		if (blocked) return blocked;
		// Trusted target truncate → pass in every mode.
		if (isTrustedPath(t.path)) continue;
		// Existing ordinary file truncated → per truncateInProject / truncateOutside
		if (!DEVICE_TARGETS.has(t.path) && existsSync(t.path)) {
			const rule =
				isOutsideCwd(t.path, realCwd) || realCwd === HOME
					? "truncateOutside"
					: "truncateInProject";
			return ruleVerdict(rule, `Truncate blocked by rule: ${t.raw}`);
		}
	}
	return { kind: "pass" };
}

/** In-place edit verdict (sed -i / perl -i / ruby -i): target hits a protected path → block */
function judgeInPlace(
	_trimmed: string,
	cmdInfo: CmdInfo,
	realCwd: string,
): SegmentVerdict {
	if (!INPLACE_EDITORS.has(cmdInfo.command)) return { kind: "pass" };
	if (
		!hasShortFlag(cmdInfo.args, "i") &&
		!hasLongFlag(cmdInfo.args, "in-place")
	) {
		return { kind: "pass" };
	}
	// sed syntax: sed -i 'script' file — target file is last (multi-file: only the last is checked; conservative enough)
	const dest = lastDestArg(cmdInfo.args);
	if (!dest) return { kind: "pass" };
	if (isUnresolvedTarget(dest)) return unresolvedTargetVerdict();
	const real = resolveReal(resolve(realCwd, expandHome(dest)));
	const blocked = protectedVerdict(
		real,
		`In-place edit of user-protected path: ${cmdInfo.command} ${dest}`,
		`In-place edit of protected path: ${cmdInfo.command} ${dest}`,
	);
	if (blocked) return blocked;
	// In-place edit of a trusted path → pass in every mode.
	if (isTrustedPath(real)) return { kind: "pass" };
	return { kind: "pass" };
}

// ─── Dangerous command classification ──────────────────────────────────
/** Dangerous command classification: "block" → system-destructive; "confirm" → privilege/remote/risky; null → not dangerous */
function dangerousLevel(fullCommand: string): "block" | "confirm" | null {
	for (const pattern of BLOCK_DANGEROUS_PATTERNS) {
		if (pattern.test(fullCommand)) return "block";
	}
	for (const pattern of CONFIRM_DANGEROUS_PATTERNS) {
		if (pattern.test(fullCommand)) return "confirm";
	}
	return null;
}

// ─── Dangerous pipe-to-shell ───────────────────────────────────────────

/** Split on the pipe operator (|), but not the logical || ; quote-aware. */
function pipeGroups(input: string): string[] {
	const groups: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			current += ch;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			current += ch;
			continue;
		}
		if (!inSingle && !inDouble && ch === "|") {
			if (input[i + 1] === "|") {
				// logical OR — keep the operator token together, not a pipe
				current += "||";
				i++;
				continue;
			}
			if (current.trim()) groups.push(current.trim());
			current = "";
			continue;
		}
		current += ch;
	}
	if (current.trim()) groups.push(current.trim());
	return groups;
}

/**
 * Whether a pipe's source references an external / outside-workspace resource.
 * Network fetchers (curl/wget) are treated as remote; interpreters are judged by
 * whether any path arg resolves outside the project.
 */
function pipeSourceIsExternal(sourceText: string, realCwd: string): boolean {
	const info = parseCommand(sourceText);
	if (!info) return false;
	if (info.command === "curl" || info.command === "wget") return true;
	for (const arg of info.args) {
		if (arg.startsWith("-")) continue;
		if (arg.includes("*") || arg.includes("?")) continue;
		if (arg.startsWith("$")) continue;
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) return true; // URL scheme
		const expanded = expandHome(arg);
		const real = resolveReal(resolve(realCwd, expanded));
		if (isOutsideCwd(real, realCwd)) return true;
	}
	return false;
}

/**
 * Scan a command for a dangerous pipe into a shell (`curl … | bash`,
 * `python -c '…' | sh`, …). Per the pipeToShell* rules: strict confirms at all
 * positions, normal passes in-workspace / confirms outside, others pass.
 */
function scanPipeToShell(text: string, realCwd: string): SegmentVerdict {
	const groups = pipeGroups(text);
	const anyBlock: string[] = [];
	let confirmRule: RuleId | undefined;
	for (let i = 1; i < groups.length; i++) {
		const right = parseCommand(groups[i]);
		if (!right || !SHELL_WRAPPERS.has(right.command)) continue;
		const left = parseCommand(groups[i - 1]);
		if (!left || !PIPE_TO_SHELL_SOURCES.has(left.command)) continue;

		const external = pipeSourceIsExternal(groups[i - 1], realCwd);
		const rule: RuleId = external ? "pipeToShellOutside" : "pipeToShellInProject";
		const reason = `Piping ${left.command} output into ${right.command} (potentially untrusted code): ${groups[i - 1]} | ${groups[i]}`;
		const lvl = rl(rule);
		if (lvl === "block") anyBlock.push(reason);
		else if (lvl === "confirm") confirmRule = rule;
	}
	if (anyBlock.length > 0) {
		return { kind: "block", reason: anyBlock.join("\n") };
	}
	if (confirmRule) return { kind: "confirm", rule: confirmRule };
	return { kind: "pass" };
}

// ─── Command Parsing ──────────────────────────────────────────────────

interface CmdInfo {
	command: string; // base command name (rm, rmdir, etc.)
	args: string[]; // non-flag args (potential paths)
}

/** Parse a shell command into name and args (strips prefix commands first) */
function parseCommand(fullCommand: string): CmdInfo | null {
	// Strip command-substitution $(...), subshell (...), and group {...} wrappers
	let cleaned = fullCommand.trim();
	// A LEADING command substitution supplies the command name itself:
	// `$(echo rm) -rf x` executes `rm -rf x` — replace it with the last word of
	// its body so the judges see the real command instead of the literal `$(echo`.
	cleaned = replaceLeadingSubstitutionCommand(cleaned);
	cleaned = cleaned.replace(/^\$\(\s*/, "").replace(/\s*\)$/, "");
	cleaned = cleaned.replace(/^\(\s*/, "").replace(/\s*\)$/, "");
	cleaned = cleaned.replace(/^\{\s*/, "").replace(/\s*;?\s*\}$/, "");

	const tokens = splitShellTokens(cleaned);
	if (tokens.length === 0) return null;

	// Strip prefix commands (sudo/nohup/timeout/env etc.) along with their flags / numbers / VAR= assignments
	const stripped = stripPrefixTokens(tokens);
	if (stripped.length === 0) return null;

	// Drop the backslash prefix (\rm) and path prefix (/bin/rm)
	const raw = stripped[0].split("/").pop() ?? stripped[0];
	const base = raw.replace(/^\\(?=[A-Za-z])/, "");
	return { command: base, args: stripped.slice(1) };
}

/**
 * Replace a leading command substitution (`$(…) ` or backtick form) with the last
 * word of its body — when a substitution sits in command-name position, its value
 * IS the executed command. Returns the input unchanged when there is no leading
 * substitution or the parentheses cannot be balanced.
 */
function replaceLeadingSubstitutionCommand(input: string): string {
	let body: string;
	let rest: string;
	if (input.startsWith("$(")) {
		let depth = 0;
		let i = 1;
		for (; i < input.length; i++) {
			if (input[i] === "(") depth++;
			else if (input[i] === ")") {
				depth--;
				if (depth === 0) break;
			}
		}
		if (depth !== 0) return input;
		body = input.slice(2, i);
		rest = input.slice(i + 1);
	} else if (input.startsWith("`")) {
		const end = input.indexOf("`", 1);
		if (end < 0) return input;
		body = input.slice(1, end);
		rest = input.slice(end + 1);
	} else {
		return input;
	}
	const words = body.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return input;
	return words[words.length - 1] + rest;
}

/** Strip prefix commands (sudo etc.), skipping their flags / numbers / VAR= assignments */
function stripPrefixTokens(tokens: string[]): string[] {
	const t = [...tokens];
	while (t.length > 0 && PREFIX_COMMANDS.has(t[0])) {
		const prefix = t.shift()!;
		while (
			t.length > 0 &&
			(t[0].startsWith("-") ||
				/^\d+$/.test(t[0]) ||
				/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]))
		) {
			const flag = t.shift()!;
			if (FLAGS_WITH_ARG.has(flag)) t.shift();
		}
		// chroot's first argument is the NEWROOT path; skip it
		if (prefix === "chroot" && t.length > 0) t.shift();
	}
	return t;
}

/** Whether the command is a delete command */
function isDeleteCommand(cmd: string): boolean {
	return DELETE_COMMANDS.has(cmd);
}

/** Whether args carry a force flag (-f / --force, supports -sf / -fdx combos) */
function hasForceFlag(args: string[]): boolean {
	return args.some((a) => {
		if (!a.startsWith("-")) return false;
		if (a.startsWith("--")) return a === "--force" || a.startsWith("--force=");
		return a.slice(1).includes("f");
	});
}

/** Overwrite command "target" — last non-flag arg; null if none */
function lastDestArg(args: string[]): string | null {
	for (let i = args.length - 1; i >= 0; i--) {
		const a = args[i];
		if (a.startsWith("-")) continue;
		if (a === ">" || a === ">>" || a === "2>" || a === "2>>") continue;
		return a;
	}
	return null;
}

/** Extract path-like tokens from args, resolve to absolute, classify in/out */
function extractPathArgs(
	args: string[],
	cwd: string,
): Array<{ raw: string; path: string; isOutside: boolean }> {
	const results: Array<{ raw: string; path: string; isOutside: boolean }> = [];

	for (const arg of args) {
		// Skip flags
		if (arg.startsWith("-")) continue;
		// Skip wildcards/redirects
		if (
			arg.includes("*") ||
			arg.includes("?") ||
			arg === ">" ||
			arg === ">>" ||
			arg === "2>" ||
			arg === "2>>"
		)
			continue;
		// Variable refs ("$HOME/.ssh") not statically resolvable → skip; falls into the no-path→confirm branch
		if (arg.startsWith("$")) continue;

		// Expand ~ / ~/xxx to HOME, or it'd be treated as an in-project relative path
		const expanded = expandHome(arg);

		const resolved = resolve(cwd, expanded);
		// Resolve symlinks so a delete target can't actually live outside the project
		const real = resolveReal(resolved);
		const outside = isOutsideCwd(real, cwd);
		results.push({ raw: arg, path: real, isOutside: outside });
	}

	return results;
}

interface RedirectTarget {
	op: string; // redirect operator (>, 2>, &>, >>, 2>>...)
	target: string; // target path
}
function extractRedirectTarget(fullCommand: string): RedirectTarget | null {
	const tokens = splitShellTokens(fullCommand);
	const REDIR = /^([0-9]*&?>>?\|?)(.*)$/;
	for (let i = 0; i < tokens.length; i++) {
		const m = REDIR.exec(tokens[i]);
		if (!m) continue;
		// Target glued to the same token (echo hi >.env)
		if (m[2]) {
			// fd duplication like 2>&1 → skip
			if (!m[2].startsWith("&")) return { op: m[1], target: m[2] };
			continue;
		}
		// Target in the next token (> /dev/sda)
		const next = tokens[i + 1];
		if (next && !next.startsWith("&")) return { op: m[1], target: next };
	}
	return null;
}

/** Whether the operator is truncating (single >, or the >| noclobber override — not >> append) */
function isTruncatingOp(op: string): boolean {
	// `>|` / `2>|` explicitly clobber a file even under noclobber → truncating
	if (op.endsWith("|")) return true;
	return op.endsWith(">") && !op.endsWith(">>");
}

/** Minimal shell tokenizer (handles single/double quotes) */
function splitShellTokens(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	for (const ch of input) {
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (/\s/.test(ch) && !inSingle && !inDouble) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (current) tokens.push(current);
	return tokens;
}

/**
 * Extract heredoc bodies (`<<TAG` / `<<-TAG`, terminated by a line equal to the
 * tag). The body is executed as script text by the shell, so it must be judged
 * like command segments; it is removed from the returned command so the
 * per-segment scanners don't misparse it. `<<<` herestrings are data, not
 * commands — left in place. The `<<TAG` marker must be unquoted; a quoted `<<'
 * literal in a string does not start a heredoc.
 */
function extractHeredocs(input: string): {
	command: string;
	bodies: string[];
} {
	const bodies: string[] = [];
	const lines = input.split("\n");
	const out: string[] = [];
	for (let li = 0; li < lines.length; li++) {
		const line = lines[li];
		const m = line.match(/<<(-?)([A-Za-z_][A-Za-z0-9_]*)/);
		if (m && m.index !== undefined && !isQuotedAt(line, m.index)) {
			const dash = m[1] === "-";
			const tag = m[2];
			const body: string[] = [];
			let closed = false;
			let lj = li + 1;
			for (; lj < lines.length; lj++) {
				const t = dash ? lines[lj].replace(/^\t+/, "").trim() : lines[lj].trim();
				if (t === tag) {
					closed = true;
					break;
				}
				body.push(lines[lj]);
			}
			bodies.push(body.join("\n"));
			// strip the <<TAG marker from the intro line, keep the rest of the command
			out.push(line.replace(m[0], "").trimEnd());
			if (closed) {
				li = lj; // skip past the terminator line
			} else {
				li = lines.length; // unterminated: the rest was body
			}
			continue;
		}
		out.push(line);
	}
	return { command: out.join("\n"), bodies };
}

/** Whether the character at idx sits inside a single/double-quoted span of line */
function isQuotedAt(line: string, idx: number): boolean {
	let sq = false;
	let dq = false;
	for (let i = 0; i < idx; i++) {
		const c = line[i];
		if (c === "'" && !dq) sq = !sq;
		else if (c === '"' && !sq) dq = !dq;
	}
	return sq || dq;
}

/** Split by shell operators (&&, ||, ;, |, newline); never inside quotes */
function splitSegments(input: string): string[] {
	const segments: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;

	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			current += ch;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			current += ch;
			continue;
		}
		if (!inSingle && !inDouble) {
			// `>|` / `>>|` is the noclobber redirect override, not a pipe separator
			const noclobber = ch === "|" && input[i - 1] === ">";
			const isSep =
				(ch === "|" && !noclobber) ||
				ch === ";" ||
				ch === "\n" ||
				(ch === "&" && input[i + 1] === "&");
			if (isSep) {
				if (current.trim()) segments.push(current.trim());
				current = "";
				if (ch === "&") i++; // skip the second &
				continue;
			}
		}
		current += ch;
	}
	if (current.trim()) segments.push(current.trim());
	return segments;
}

/** Warning confirmation before adding a trusted path: that path bypasses all path-guard prompts in every mode */
async function confirmTrustPath(
	ctx: ExtensionCommandContext,
): Promise<boolean> {
	// No UI (headless) cannot confirm → conservatively refuse the trust
	if (!ctx.hasUI) return false;
	return ctx.ui.confirm("⚠️ Trust this path?", TRUST_PATH_WARNING);
}

/** Warning confirmation before switching to trusted: behavior boundary is very loose; requires explicit user confirmation */
async function confirmTrustedSwitch(
	ctx: ExtensionCommandContext,
): Promise<boolean> {
	// No UI (headless) cannot confirm → conservatively refuse the switch
	if (!ctx.hasUI) return false;
	return ctx.ui.confirm("⚠️ Switch to trusted mode?", TRUSTED_SWITCH_WARNING);
}

/** Double confirmation before switching to naked: disables ALL protection (incl. protected paths, destructive commands, and write/edit checks) */
async function confirmNakedSwitch(
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
async function confirmModeSwitch(
	mode: GuardMode,
	ctx: ExtensionCommandContext,
): Promise<boolean> {
	if (mode === "trusted") return confirmTrustedSwitch(ctx);
	if (mode === "naked") return confirmNakedSwitch(ctx);
	return true;
}


async function askConfirm(
	ctx: ExtensionContext,
	message: string,
	confirmRules: RuleId[] = [],
): Promise<ToolCallEventResult | undefined> {
	if (!ctx.hasUI) {
		return {
			block: true,
			reason: withEscapeHints(tagged("noUi", "No interactive UI; blocked")),
		};
	}

	// Third option: allow this once and session-pass the triggering rule(s). Shown
	// only outside naked (where a confirm already means "very dangerous") and never
	// for an excluded rule.
	const eligible =
		getMode() === "naked"
			? []
			: [...new Set(confirmRules)].filter((r) => !SESSION_PASS_EXCLUDED.has(r));
	const options = ["✅ Allow", "❌ Deny"];
	let passChoice: string | null = null;
	if (eligible.length === 1) {
		passChoice = `🔓 Allow & set ${eligible[0]} = pass (session)`;
	} else if (eligible.length > 1) {
		passChoice = `🔓 Allow & set ${eligible.length} rules = pass (session)`;
	}
	if (passChoice) options.push(passChoice);

	const choice = await ctx.ui.select(message, options);

	if (passChoice && choice === passChoice) {
		for (const r of eligible) sessionPassRule(getMode(), r);
		ctx.ui.notify(
			`Path Guard: ${eligible.join(", ")} = pass for this session (not persisted)`,
			"info",
		);
		return undefined; // allow this operation
	}
	if (choice !== "✅ Allow") {
		return { block: true, reason: "User denied the operation" };
	}
	return undefined; // allow
}
