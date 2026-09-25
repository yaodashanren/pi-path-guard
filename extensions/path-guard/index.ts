import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyConfig, clearSessionPass, getConfig, readSavedConfig, getMode, isGuardMode, persistConfig, persistNote, setMode } from "./rules.ts";
import { GUARD_MAIN_MENU, confirmModeSwitch, handlePathsCommand, runGuardPanel, runModePicker, runPathsMenu, runRulesMenu } from "./panel.ts";
import { checkBashCommand, checkWriteEdit } from "./pipeline.ts";

/**
 * Path Guard Extension — protects against accidental deletes / overwrites / edits
 *
 * Version history lives in CHANGELOG.md (aligned with package.json); the most
 * recent release/tag is 1.7.0.
 */

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




/** Per-segment check: protected redirect → block; dangerous commands → confirm/block; the rest to sub-judges / wrapper recursion */



































// ─── Dangerous pipe-to-shell ───────────────────────────────────────────




// ─── Command Parsing ──────────────────────────────────────────────────

















