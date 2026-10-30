import type {
	BashToolInput,
	EditToolInput,
	ExtensionAPI,
	WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import {
	applyConfig,
	clearSessionPass,
	ensureProjectLayer,
	getConfig,
	getConfigWarnings,
	getMode,
	getWriteScope,
	isGuardMode,
	persistNote,
	readSavedConfig,
	setMode,
	setModeIn,
	setWriteScope,
} from "./rules.ts";
import {
	GUARD_MAIN_MENU,
	confirmModeSwitch,
	handlePathsCommand,
	handleProjectCommand,
	runGuardPanel,
	runModePicker,
	runPathsMenu,
	runRulesMenu,
	runScopeMenu,
} from "./panel.ts";
import { doctorView } from "./doctor.ts";
import { explainView } from "./explain.ts";
import { checkBashCommand, checkWriteEdit } from "./pipeline.ts";

/**
 * Path Guard Extension — protects against accidental deletes / overwrites / edits
 *
 * Version history lives in CHANGELOG.md (aligned with package.json); the most
 * recent release/tag is 1.11.0. /guard explain — a read-only
 * classification trace (/guard explain <command>) backed by the
 * TraceCollector in trace.ts, with zero verdict behavior change.
 * /guard rules — a two-level picker (mode -> rule group -> rule) whose rows
 * show each rule's effective level plus its provenance (default / [global] /
 * [project] / session-pass), shared by the CLI editor and the /guard overlay.
 */

/** Entry point: register event handlers and the /guard command. */
export default function (pi: ExtensionAPI) {
	// Restore the persisted config on every new session (startup, /new, /resume all
	// fire session_start): active mode + user protected paths + rule overrides.
	pi.on("session_start", (_event, ctx) => {
		const cfg = readSavedConfig(ctx.cwd, ctx.isProjectTrusted?.() === true);
		applyConfig(cfg);
		clearSessionPass();
		setMode(getConfig().mode, ctx.ui);
		// Config problems (bad JSON, unknown fields, dropped relative paths) are
		// surfaced once per session instead of silently falling back to defaults.
		const configWarnings = getConfigWarnings();
		if (configWarnings.length > 0) {
			const shown = configWarnings.slice(0, 3).map(
				(w) => `· ${w.path}: ${w.field ? `${w.field}: ` : ""}${w.message}`,
			);
			const more =
				configWarnings.length > shown.length
					? `\n… and ${configWarnings.length - shown.length} more (see /guard project)`
					: "";
			ctx.ui.notify?.(
				`Path Guard: config warnings (${configWarnings.length})\n${shown.join("\n")}${more}`,
				"warning",
			);
		}
		// A hand-authored cwd/.pi/settings.json pathGuard block is only in effect
		// when no projects entry matched (applyConfig overlays project ??
		// authored); hint once so the user knows to migrate it to a managed
		// project entry (spec §9).
		if (cfg.authored && !cfg.project) {
			ctx.ui.notify?.(
				`hand-authored .pi/settings.json pathGuard block detected at ${cfg.authored.file} — run /guard project import to migrate it to a project entry`,
				"info",
			);
		}
		// A persisted loose mode survives into every new session; surface it so the
		// user never runs unprotected without noticing (naked in particular).
		if (getConfig().mode === "naked") {
			ctx.ui.notify(
				"⚠️ Path Guard restored in NAKED mode — nearly all protection is OFF " +
					"(persisted from a previous session). Use /guard normal to re-enable.",
				"warning",
			);
		} else if (getConfig().mode === "trusted") {
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
			"Path Guard: /guard shows mode, /guard <strict|normal|loose|trusted|naked> switches, /guard paths <protected|trusted> add|rm|list|clear <path> manages paths, /guard doctor shows the layered-config status report, /guard explain <command> previews how a command would be judged (read-only)",
		handler: async (args, ctx) => {
			let raw = args?.trim() ?? "";
			// `/guard --project <anything>` saves the edit to this project's entry file.
			const projectScope = /^--project(\s|$)/i.test(raw);
			if (projectScope) raw = raw.replace(/^--project\s*/i, "").trim();
			setWriteScope(projectScope ? "project" : "global");
			const m = raw.toLowerCase();

			// ── /guard project … : inspect/import/remove this project's config ──
			if (m === "project" || m.startsWith("project ")) {
				return handleProjectCommand(raw, ctx);
			}

			// ── /guard doctor : layered-config status report (works without UI) ──
			if (m === "doctor") {
				ctx.ui.notify(doctorView(ctx.cwd), "info");
				return;
			}
			// ── /guard explain <command> : read-only classification trace (works without UI) ──
			if (m === "explain" || m.startsWith("explain ")) {
				const target = raw.slice("explain".length).trim();
				ctx.ui.notify(
					target
						? explainView(target, { cwd: ctx.cwd, hasUI: ctx.hasUI })
						: "Usage: /guard explain <command>",
					"info",
				);
				return;
			}
			if (projectScope) {
				// Create the entry on first use so /guard --project <mode> works from scratch.
				const ensured = ensureProjectLayer(ctx.cwd);
				if (!ensured.ok) {
					ctx.ui.notify(
					`Path Guard: ${ensured.error} — not switched; still ${getMode()}`,
						"warning",
					);
					return;
				}
			}

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
				const where = setModeIn(getWriteScope(), m, ctx.cwd);
			setMode(getConfig().mode, ctx.ui);
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
				else if (option === "scope") await runScopeMenu(ctx);
				else if (option === "doctor") ctx.ui.notify(doctorView(ctx.cwd), "info");
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




/** Per-segment check: protected redirect → block; dangerous commands → confirm/block; the rest to sub-judges / wrapper recursion */



































// ─── Dangerous pipe-to-shell ───────────────────────────────────────────




// ─── Command Parsing ──────────────────────────────────────────────────

















