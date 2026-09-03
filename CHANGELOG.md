# Changelog

All notable changes to this project are documented here, aligned with
`package.json`. The current mode/tag is always the latest `## [Unreleased]` /
released entry below. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.4.7] — category-aware block escape hints

- Every block message now appends a short, category-aware hint under a
  `To run anyway / 如需执行:` header — an English hint followed by its Chinese
  note on a separate indented line — so a blocked command tells the user how to
  actually proceed instead of failing opaquely:
  - user-configured protected paths → remove with `/guard paths rm <path>`
    (they are enforced in every mode, so a mode switch cannot help)
  - built-in protected paths → only `/guard naked` bypasses
  - system-destructive commands → `/guard naked` (still prompts once)
  - no-interactive-UI confirm blocks → run in the TUI or loosen the rule to pass
  - rule-level blocks → `/guard loose` or tune the rule via `/guard rules`
- Hints are injected at the central boundaries only (bash aggregate +
  write/edit + headless-confirm), classified from each blocked reason line;
  judgement logic is unchanged.
- Tests: 4 new assertions covering each category's hint; 148 passing.

## [1.4.5] — docs & changelog maintenance

- Moved the full version history out of the `extensions/path-guard.ts` header
  comment into a standalone `CHANGELOG.md` (keeps the source header short).
- README: added a `## Changelog` section linking the file; fixed the stale test
  count (143 → 144) in the Development section.
- Removed the unused empty `scripts/` directory.
- Added `CHANGELOG.md` to the `package.json` `files` publish whitelist.
- No judgement logic or behaviour changed.

## [1.4.4] — fix switch-mode picker shows the current state

- Fix: the `/guard` switch-mode picker title was showing the hardcoded built-in
  default matrix (the old `MODE_MATRIX` constant), ignoring per-rule overrides.
  It now renders the **effective (override-aware)** matrix via `rulesMatrix()`
  — the same one the rules-menu `overview` shows — so the displayed levels
  always reflect any `pathGuard.rules.{mode}.{rule}` overrides.
- Deleted the now-unused `MODE_MATRIX` constant.
- Test: switch picker title must contain "effective rules matrix".
- Tests: 144 passing.

## [1.4.3] — fix the scrollable overview viewer now closes

- Fix: the scrollable `overview` matrix viewer could be shown but not closed.
  The docs pattern `component.onKey` is not a real method in current pi-tui, so
  keys never reached the component. Reworked the viewer to receive raw input via
  the actual `custom()` component interface: `component.handleInput(data)` with
  `matchesKey(...)` for key detection and `done()` (the factory's 4th arg) to
  close. Tests exercise closing via `handleInput("q")`.

## [1.4.2] — fix the overview matrix is no longer truncated

- Fix: the rules-menu `overview` matrix was too large for a `notify` popup and
  for the string-array widget (hard-capped at 10 lines), so it got truncated.
  It is now shown in a full scrollable read-only viewer via `ctx.ui.custom()`
  (`ScrollView` + `Text` from pi-tui, with ↑/↓/PgUp/PgDn/Home/End scroll and
  q/⏎/esc to close), falling back to the widget for headless / minimal-UI
  environments.

## [1.4.1] — the main menu loops

- The main `/guard` menu now loops: a sub-menu's `back` returns to the previous
  menu (and eventually to the main menu); only cancelling at the top level exits
  the command.

## [1.4.0] — interactive per-mode rule customization

- New `/guard → rules` sub-menu: pick a mode → the rule editor lists all 14
  rules with their current levels; pick one → set block/confirm/pass or reset to
  the built-in default. Stays in the editor so several rules per mode can be set
  before choosing `back`. Also offers a read-only full `overview` matrix and a
  `reset` that clears all overrides.
- Writes `pathGuard.rules.{mode}.{rule}` in settings.json, reusing the existing
  persistence (`readSavedConfig` / `persistConfig` / `rlFor`); no judgement
  logic was touched.

## [1.3.1] — /guard interactive two-level menu

- A bare `/guard` (has UI) now shows a main menu instead of jumping straight
  into the mode picker: choose "Switch mode" (the original picker) or "Manage
  custom protected paths" (shows the current list, then loops add / remove /
  clear / back). Future top-level actions extend `GUARD_MAIN_MENU`.
- Custom-path management is now friendly in the UI: add uses `ctx.ui.input` to
  type the path, remove picks from the current list, clear double-checks via
  confirm, back returns. The `/guard paths add|rm|list|clear` subcommands and
  `/guard <mode>` shortcuts still work.

## [1.3.0] — configurable protected paths and tunable rules

- User-configured protected paths (`pathGuard.extraProtected`, or
  `/guard paths add|rm|list|clear`) are enforced in EVERY mode including naked.
- The 5 modes' judgement rules are tunable per mode via
  `pathGuard.rules.{mode}.{rule}` in settings.json (rule = block|confirm|pass;
  valid rule IDs listed in `RULE_IDS`). The built-in defaults match the earlier
  hardcoded behaviour; overrides only adjust the listed rule.
- New dangerous pipe-to-shell checks: `curl … | bash` / `wget -qO- … | sh` /
  `python -c '…' | sh` (output of network fetchers / inline interpreter code
  piped into a shell). strict confirms at all positions; normal passes
  in-workspace / confirms remote-outside sources; loose/trusted/naked pass.
  Tunable via `pipeToShellInProject` and `pipeToShellOutside` rules.

## [1.2.0] — mode persistence across sessions

- The active mode is read from settings.json on `session_start` (project
  `pi/settings.json` overrides global `~/.pi/agent/settings.json`, falling back
  to normal) and written back when `/guard` switches mode.

## [1.1.0] — naked mode

- Adds `naked` mode: passes almost everything (protected paths, write/edit
  checks, git destructive, truncate, outside deletes/overwrites); only
  system-destructive Block-group commands (mkfs / reboot / block-device writes /
  bulk delete) are still confirmed. Switching to naked requires a double
  confirmation (stronger than trusted's single warning).

## [1.0.0] — initial release

- Protected-path interception (.env /.ssh / keys / credentials, regardless of
  project).
- Dangerous-command judgment: Block group (mkfs / reboot / block-device writes /
  bulk delete) and Confirm group (sudo / ssh / chmod 777 …); no-UI environments
  fall back to block.
- Prefix-command stripping (sudo/doas/pkexec/env/nohup/timeout/setsid/chroot/
  watch …) to analyze the real command; shell wrapper recursion (bash -c / eval,
  depth-limited); quote-aware tokenization; compound-command segmentation with
  fail-safe aggregation.
- realpath resolution (walk up to the nearest existing ancestor) so deep missing
  paths are not written through symlinks to outside the project; symlinked cwd
  resolved before judging.
- mv/cp/install/tee/ln -f/rsync existing-target overwrite detection;
  `> existing file` truncate detection (excluding append and devices);
  dd / curl -o / wget -O / unzip -o judgment.
- git destructive-command checks (clean -f / reset --hard / checkout --. /
  restore. / branch -D / push --force / stash drop), honoring -C/-c global
  option prefixes.
- Guard modes via `/guard`: strict / normal / loose / trusted; footer status bar
  shows the active mode.
