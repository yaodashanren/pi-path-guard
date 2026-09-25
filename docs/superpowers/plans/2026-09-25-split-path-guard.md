# Split path-guard.ts into modules — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 4117-line single-file extension `extensions/path-guard.ts` into focused modules under `extensions/path-guard/` (entry `index.ts`) with zero behavior change, verified by the existing 328-test suite after every task.

**Architecture:** pi loads every direct `.ts` file in the extensions dir as its own extension entry, but loads a *subdirectory* only via its `index.ts` — so the split files must live in `extensions/path-guard/` with `index.ts` as the single entry. Module dependency graph is kept strictly acyclic and one-directional: `constants` / `escape` (leaves) → `paths` → `rules` (all mutable state lives here) → `shell-parse` → `judges` → `pipeline` + `panel` → `index` (entry). All code moves are **verbatim** — no logic edits, no renames except accessors for module-private mutable state.

**Tech Stack:** TypeScript (Node v22 type-stripping, no build step), pi Extension API, existing suite `node tests/test-pathguard.ts`.

**Spec:** This plan implements the "单文件拆分" P2 item recorded in `../path-improvement-glm5.3flash.md` (split into rules/judges/panel/entry), refined by this plan's structure survey.

## Global Constraints

- **Zero behavior change.** No rule ladder, message text, mode default, or persistence format may change. The 328-test suite must pass after *every* task (`node tests/test-pathguard.ts` from repo root).
- **No new runtime dependencies.** Node builtins + `@earendil-works/pi-coding-agent` types only (same imports as today).
- **Entry point:** `package.json` already points at `./extensions` — do **not** change it. pi discovers `extensions/path-guard/index.ts` automatically.
- **Single extension entry.** Only `index.ts` may have a `default` export registered via `mod.default(pi)`. No other module may export a default.
- **Mutable state lives in exactly one module** (`rules.ts`): `currentMode`, `config`, `extraProtected`, `trustedPaths`, `sessionPass`, `lastPersistError`. Other modules read via exported accessor functions; mutation happens only inside `rules.ts`.
- **No circular imports.** Allowed import edges only (nothing may import from `pipeline`/`panel`/`index` except `index`):
  `escape → (nothing)`; `constants → (nothing)`; `paths → constants`; `rules → constants, escape, paths`; `shell-parse → constants, paths`; `judges → constants, escape, paths, rules, shell-parse`; `panel → constants, escape, rules`; `pipeline → all except panel/index`; `index → pipeline, panel, rules`.
- **Types move with their owner module** (`SegmentVerdict`/`CmdInfo`/`RedirectTarget` → `judges.ts` / `shell-parse.ts`; `GuardMode`/`RuleId`/`PathGuardConfig` → `rules.ts`); consumers import them — no duplicate declarations.
- Version becomes **1.7.0** (structural change → minor bump). CHANGELOG entry required. Test file update: `EXT` URL in `tests/test-pathguard.ts:22` points to `../extensions/path-guard/index.ts`.
- Run tests from repo root: `cd /Users/Shared/share_files/Project_Code/pi/pi-path-guard && node tests/test-pathguard.ts`. Expected after every task: `✅ 328 passed, ❌ 0 failed`.

## Review Focus

- **Circular import at runtime:** Node ESM would throw `ReferenceError: Cannot access before initialization` for any edge drawn the wrong way. Pinned by: suite passing (it imports `index.ts` which transitively loads everything).
- **Forgotten `export` keyword** when moving a symbol a sibling module needs. Pinned by: suite failing to load (module not found / undefined import) — caught by running tests immediately after each move.
- **Mutable state accidentally duplicated** (e.g. `currentMode` read from a stale copy). Pinned by: mode-ladder tests in the suite (strict/normal/loose/trusted/naked × commands) — they fail if two copies diverge.
- **Double extension registration:** a sibling module accidentally left in `extensions/` root would be loaded as a second extension. Pinned by: Task 1's `git status` check that `extensions/` contains only `path-guard/`; suite also fails if `default` export missing.
- **Panel/settings regressions invisible to pure-judgment tests:** `/guard` TUI overlay and settings persistence are exercised by the suite's panel tests (`openGuardPanel` helper, `panel-settings.json` fixture) — those must stay green; do not skip them when they fail.

---

## Current Structure (survey — exact symbol inventory per target module)

Line numbers refer to `extensions/path-guard.ts` @ 1.6.3 (4117 lines). Move code **verbatim**; ranges are a map, not a cutting instruction — re-grep before moving.

### → `extensions/path-guard/constants.ts` (~190 lines, leaf)
- L46–222: `PROTECTED_PATH_PATTERNS`, `EXACT_ONLY_PATTERNS`, `SAFE_CREDENTIAL_SUFFIXES`, `DELETE_COMMANDS`, `OVERWRITE_COMMANDS`, `INPLACE_EDITORS`, `SHELL_WRAPPERS`, `PIPE_TO_SHELL_SOURCES`, `PREFIX_COMMANDS`, `FLAGS_WITH_ARG`, `DEVICE_TARGETS`, `HOME`, `CONFIG_DIR`
- L2261: `SHELL_INTERPRETERS`
- L3921–3935: `TRUST_PATH_WARNING`, `TRUSTED_SWITCH_WARNING`, `NAKED_SWITCH_WARNING_1`, `NAKED_SWITCH_WARNING_2` (UI copy constants consumed by panel)
- Export everything above with `export const`.

### → `extensions/path-guard/escape.ts` (~80 lines, leaf)
- L4038–4117: `EscapeCat`, `ESCAPE_HINTS`, `tagged`, `CAT_TAG_RE`, `escapeCatOf`, `withEscapeHints`

### → `extensions/path-guard/paths.ts` (~60 lines)
- L3387–3919 (path-util sections only): `isOutsideCwd` (3390), `matchesProtectedPath` (3399), `expandHome` (3689), `isUnresolvedTarget` (3701), `isRemoteTarget` (3710), `isDirectory` (3880), `resolveReal` (3895)
- Imports: `constants` (patterns, `HOME`), `node:path`, `node:fs`.

### → `extensions/path-guard/rules.ts` (~900 lines — all mode/rule/state/persistence)
- L224–260: `GuardMode`, `GUARD_MODES`, `currentMode`, `isGuardMode`, `inNaked` (L505)
- L260–584: `RuleLevel`, `RuleId`, `RULE_IDS` (292), `RULE_DESCRIPTIONS` (317), `RULE_LEVEL_LABELS` (347), `DEFAULT_MODES` (358), `isRuleLevel` (353), `rl` (477), `rlFor` (485), `ruleVerdict` (490), `extraProtected` (511) + `isUserProtectedPath` (514) + `normalizeProtectedEntry` (530), `trustedPaths` (547) + `PathKind` (550) + `pathList` (553) + `isTrustedPath` (558) + `untrustableReason` (572), `GuardVerdict` (586)
- L591–608: `setMode` (594), `refreshModeStatus` (603)
- L610–816: `globalSettingsPath` (614), `isHomeCwd` (625), `projectSettingsPath` (631), `PathGuardConfig` (639), `config` (646), `sessionPass` (659) + `isSessionPassed` (662) + `sessionPassRule` (667) + `clearSessionPass` (672), `readSettingsGuard` (681), `readSavedConfig` (740), `lastPersistError` (772) + `persistConfig` (774) + `persistNote` (810)
- L3986: `SESSION_PASS_EXCLUDED`
- **Mutation exports:** other modules previously assigned `currentMode` / `config` etc. directly; expose and use accessor functions instead: `getMode()`, plus the existing `setMode`, `readSavedConfig`, `persistConfig`, `sessionPassRule`, `clearSessionPass`, path-list mutators (add whatever `actionAddPath`/`actionRemovePath`/`actionClearPaths` in panel need, e.g. `addProtectedPath/addTrustedPath/removePath/clearPaths` — keep existing `normalizeProtectedEntry` validation inside).
- `ruleVerdict` needs `tagged` from `escape` — allowed edge (`rules → escape`).
- `setMode`/`refreshModeStatus` take `ui: ExtensionUIContext` — keep signatures; type imports move here.

### → `extensions/path-guard/shell-parse.ts` (~450 lines, pure functions)
- `splitShellTokens` (3753), `splitSegments` (3840), `parseCommand` (3548), `stripPrefixTokens` (3608), `replaceLeadingSubstitutionCommand` (3578), `extractRedirectTarget` (3726) + `RedirectTarget` (3720) + `isTruncatingOp` (3746), `extractHeredocs` (3788) + `isQuotedAt` (3828), `extractCommandSubstitutions` (2504), `findMatchingParen` (2571), `extractPathArgs` (3653), `lastDestArg` (3642), `hasForceFlag` (3633), `hasShortFlag` (3171), `hasLongFlag` (3178), `isDeleteCommand` (3628), `CmdInfo` (3542)
- Imports: `constants` (`PREFIX_COMMANDS`, `FLAGS_WITH_ARG`, `DELETE_COMMANDS`), `paths` (`expandHome`, `isUnresolvedTarget`, `isRemoteTarget`, `resolveReal`).

### → `extensions/path-guard/judges.ts` (~1100 lines)
- `SegmentVerdict` (2254), `scriptTargetOf` (2268), `unresolvedScriptTail` (2292), `tailLooksUserProtected` (2304), `judgeUnresolvedScriptTarget` (2331), `judgeUnresolvedRedirectTarget` (2366), `judgeScript` (2397), `judgeScriptTargetPath` (2448), `inputRedirectTarget` (2461), `judgeInputRedirect` (2473), `classifySubstitutions` (2603), `classifySegment` (2632), `classifySegmentOuter` (2675), `judgeShellWrapper` (2807), `judgeWriters` (2848), `tarIsExtraction` (2880), `judgeGit` (2901), `judgeDelete` (2981), `judgeOverwrite` (3045), `unwrapShellWrapper` (3150), `judgeDd` (3183), `judgeDownload` (3209), `unresolvedTargetVerdict` (3239), `protectedVerdict` (3246), `outsideWriteVerdict` (3262), `downloadTarget` (3277), `wgetDownloadTarget` (3284), `curlDownloadTarget` (3298), `judgeTruncate` (3321), `judgeInPlace` (3359), `dangerousLevel` (3443), pipe-to-shell block: `pipeGroups` (3456), `pipeSourceIsExternal` (3495), `scanPipeToShell` (3516)
- Imports: all of `constants`, `escape`, `paths`, `rules` (`inNaked`, `ruleVerdict`, `isUserProtectedPath`, `isTrustedPath`), `shell-parse`.

### → `extensions/path-guard/panel.ts` (~1100 lines — /guard menus, actions, TUI overlay)
- L818–1393: `PATHS_USAGE` (818), shared actions `actionSwitchMode` (894) … `actionClearPaths` (979), `GUARD_MAIN_MENU` (994), `GUARD_PATHS_CATEGORY_MENU` (1001), `pathsActionsMenu` (1008), `GUARD_RULES_MENU` (1169), `OVERVIEW_WIDGET` (1177), `rulesMatrix` (1195), `rulesSummary` (1218)
- L1395–1991: `PanelScreen` (1402), `PendingConfirm` (1417), `PanelTheme` (1424), `panelOptions` (1427), `framePanel` (1482), `class GuardPanel` (1500)
- Imports: `constants` (warnings copy), `escape` (hint display), `rules` (everything state-related; uses the new mutator accessors for path lists).

### → `extensions/path-guard/pipeline.ts` (~160 lines — command/write entry points)
- `checkWriteEdit` (2099), `checkBashCommand` (2177)
- Imports: `judges`, `shell-parse`, `rules`, `paths`, `escape`, `constants`.

### → `extensions/path-guard/index.ts` (~110 lines — the only default export)
- L1–41 imports (pi types + node builtins, distributed to owners), L1993–2097 `export default function (pi: ExtensionAPI)` registration body verbatim.
- Re-exports nothing else.

## File Structure (final state)

```
extensions/
└── path-guard/
    ├── index.ts        (~110)   entry: default export, registration only
    ├── constants.ts    (~200)   leaf: patterns, command sets, device targets, copy constants
    ├── escape.ts       (~80)    leaf: [cat:] tagging, escape hints
    ├── paths.ts        (~60)    path classification utils
    ├── rules.ts        (~900)   modes, rules, ALL mutable state, settings persistence
    ├── shell-parse.ts  (~450)   tokenizing / parsing (pure)
    ├── judges.ts       (~1100)  judge* + classification pipeline
    ├── panel.ts        (~1100)  /guard actions, menus, GuardPanel TUI
    └── pipeline.ts     (~160)   checkWriteEdit / checkBashCommand
```
`extensions/path-guard.ts` is deleted in Task 1 (its content becomes `index.ts`). `tests/test-pathguard.ts` keeps one diff: the `EXT` URL.

---

### Task 1: Move the file wholesale into `extensions/path-guard/index.ts`

**Files:**
- Create: `extensions/path-guard/index.ts`
- Delete: `extensions/path-guard.ts`
- Modify: `tests/test-pathguard.ts:22`

**Interfaces:**
- Produces: the directory-form extension pi will load via `index.ts`; identical behavior.

- [ ] **Step 1: Move file**

```bash
cd /Users/Shared/share_files/Project_Code/pi/pi-path-guard
mkdir -p extensions/path-guard
git mv extensions/path-guard.ts extensions/path-guard/index.ts
```

- [ ] **Step 2: Point the test suite at the new entry**

In `tests/test-pathguard.ts` line 22, change:

```ts
const EXT = new URL("../extensions/path-guard.ts", import.meta.url).href;
```
to:
```ts
const EXT = new URL("../extensions/path-guard/index.ts", import.meta.url).href;
```

- [ ] **Step 3: Verify no stray extension files remain in `extensions/` root**

Run: `ls extensions/`
Expected: only the `path-guard/` directory (plus nothing else — a stray `.ts` here would be loaded as a second extension).

- [ ] **Step 4: Run the suite**

Run: `node tests/test-pathguard.ts`
Expected: `✅ 328 passed, ❌ 0 failed`

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: move path-guard.ts to extensions/path-guard/index.ts (no changes)"
```

---

### Task 2: Extract leaf modules `constants.ts` and `escape.ts`

**Files:**
- Create: `extensions/path-guard/constants.ts`, `extensions/path-guard/escape.ts`
- Modify: `extensions/path-guard/index.ts` (delete moved code, add imports)

**Interfaces:**
- Consumes: nothing (leaves).
- Produces: all constants listed in the survey's `constants.ts` / `escape.ts` sections, each `export`ed with the **same name**. `index.ts` imports what it still uses.

- [ ] **Step 1: Cut the constant blocks (survey line ranges) from `index.ts` into `constants.ts`, adding `export` to each declaration. Add needed node imports (`homedir` for `HOME`) at the top.**

- [ ] **Step 2: Cut the escape-hint block (L4038–4117) into `escape.ts` the same way.**

- [ ] **Step 3: In `index.ts`, replace the removed declarations with imports:**

```ts
import { PROTECTED_PATH_PATTERNS, DEVICE_TARGETS, HOME /* …only what index still uses */ } from "./constants.ts";
import { withEscapeHints } from "./escape.ts";
```

- [ ] **Step 4: Run the suite**

Run: `node tests/test-pathguard.ts`
Expected: `✅ 328 passed, ❌ 0 failed` (extension loads through the new imports; if a symbol is missing you get a load error — fix the import list, do not duplicate declarations).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: extract leaf modules constants.ts and escape.ts"
```

---

### Task 3: Extract `paths.ts`

**Files:**
- Create: `extensions/path-guard/paths.ts`
- Modify: `extensions/path-guard/index.ts`

**Interfaces:**
- Consumes: `constants` (`PROTECTED_PATH_PATTERNS`, `EXACT_ONLY_PATTERNS`, `SAFE_CREDENTIAL_SUFFIXES`, `HOME`), `node:path`, `node:fs`.
- Produces: `isOutsideCwd`, `matchesProtectedPath`, `expandHome`, `isUnresolvedTarget`, `isRemoteTarget`, `isDirectory`, `resolveReal` (all `export function`, bodies verbatim).

- [ ] **Step 1: Move the seven functions verbatim; add imports from `./constants.ts`.**

- [ ] **Step 2: Import them in `index.ts`; delete the local copies.**

- [ ] **Step 3: Run the suite — expected 328 passed.**

- [ ] **Step 4: Commit** — `git commit -m "refactor: extract paths.ts"`

---

### Task 4: Extract `rules.ts` (modes, rules, all mutable state, persistence)

**Files:**
- Create: `extensions/path-guard/rules.ts`
- Modify: `extensions/path-guard/index.ts`

**Interfaces:**
- Consumes: `constants`, `escape` (`tagged` for `ruleVerdict`), `paths` (nothing yet — add only if needed).
- Produces (all verbatim unless noted): types `GuardMode`, `RuleLevel`, `RuleId`, `PathKind`, `PathGuardConfig`, `GuardVerdict`; consts `GUARD_MODES`, `RULE_IDS`, `RULE_DESCRIPTIONS`, `RULE_LEVEL_LABELS`, `DEFAULT_MODES`, `SESSION_PASS_EXCLUDED`; functions `isGuardMode`, `rl`, `rlFor`, `ruleVerdict`, `isRuleLevel`, `isUserProtectedPath`, `normalizeProtectedEntry`, `pathList`, `isTrustedPath`, `untrustableReason`, `setMode`, `refreshModeStatus`, `globalSettingsPath`, `isHomeCwd`, `projectSettingsPath`, `readSettingsGuard`, `readSavedConfig`, `persistConfig`, `persistNote`, `isSessionPassed`, `sessionPassRule`, `clearSessionPass`, `inNaked`.
- **State accessors (the only intentional renames):** `getMode(): GuardMode` (replaces direct `currentMode` reads outside rules), plus mutators for path lists used by panel actions: `addProtectedPath(entry)`, `addTrustedPath(entry)`, `removePath(kind, entry)`, `clearPaths(kind)` — bodies taken from the corresponding `action*` logic that touched `extraProtected`/`trustedPaths` directly, so panel code calls these instead of assigning arrays.
- `config` is not exported; expose anything `index`/`panel` read from it via functions that already exist (`rl`, `readSettingsGuard`, …). If some reader remains, add a narrow getter, never export the mutable object.

- [ ] **Step 1: Move the survey-listed blocks verbatim; convert outside assignments to the accessors above.**

- [ ] **Step 2: Update `index.ts` imports; delete moved code.**

- [ ] **Step 3: Run the suite — expected 328 passed.** The mode-ladder and persistence tests (`panel-settings.json` fixture, `PI_PATH_GUARD_SETTINGS` override) must stay green; a failure here almost always means a second copy of mutable state — re-check exports.

- [ ] **Step 4: Commit** — `git commit -m "refactor: extract rules.ts (modes, rules, state, persistence)"`

---

### Task 5: Extract `shell-parse.ts`

**Files:**
- Create: `extensions/path-guard/shell-parse.ts`
- Modify: `extensions/path-guard/index.ts`

**Interfaces:**
- Consumes: `constants`, `paths`.
- Produces: types `CmdInfo`, `RedirectTarget`; functions `splitShellTokens`, `splitSegments`, `parseCommand`, `stripPrefixTokens`, `replaceLeadingSubstitutionCommand`, `extractRedirectTarget`, `isTruncatingOp`, `extractHeredocs`, `isQuotedAt`, `extractCommandSubstitutions`, `findMatchingParen`, `extractPathArgs`, `lastDestArg`, `hasForceFlag`, `hasShortFlag`, `hasLongFlag`, `isDeleteCommand` — all verbatim, all `export`ed.

- [ ] **Step 1: Move functions verbatim; wire imports (`PREFIX_COMMANDS`, `FLAGS_WITH_ARG`, `DELETE_COMMANDS` from constants; `expandHome`, `isUnresolvedTarget`, `isRemoteTarget`, `resolveReal` from paths).**

- [ ] **Step 2: Update `index.ts` imports; delete moved code.**

- [ ] **Step 3: Run the suite — expected 328 passed.**

- [ ] **Step 4: Commit** — `git commit -m "refactor: extract shell-parse.ts"`

---

### Task 6: Extract `judges.ts`

**Files:**
- Create: `extensions/path-guard/judges.ts`
- Modify: `extensions/path-guard/index.ts`

**Interfaces:**
- Consumes: `constants`, `escape`, `paths`, `rules`, `shell-parse` (largest import fan-in — this is the dependency sink).
- Produces: type `SegmentVerdict`; every function in the survey's judges section, verbatim and exported. `judgeWriters` keeps its pipeline array unchanged.

- [ ] **Step 1: Move the judges + classification + pipe-to-shell blocks verbatim.**

- [ ] **Step 2: Update `index.ts` imports; delete moved code. `index.ts` should now contain only: pi imports, the `export default function (pi)` registration, `checkWriteEdit`, `checkBashCommand`.**

- [ ] **Step 3: Run the suite — expected 328 passed.**

- [ ] **Step 4: Commit** — `git commit -m "refactor: extract judges.ts"`

---

### Task 7: Extract `panel.ts` and `pipeline.ts`; `index.ts` becomes the thin entry

**Files:**
- Create: `extensions/path-guard/panel.ts`, `extensions/path-guard/pipeline.ts`
- Modify: `extensions/path-guard/index.ts` (final shape: ~110 lines)

**Interfaces:**
- `pipeline.ts` consumes `judges`, `shell-parse`, `rules`, `paths`, `escape`, `constants`; produces `checkWriteEdit`, `checkBashCommand` (verbatim).
- `panel.ts` consumes `constants` (warning copy), `escape`, `rules` (uses the Task-4 mutator accessors instead of touching arrays); produces the `action*` functions, menus, `rulesMatrix`, `rulesSummary`, `rulesSummary`, `GuardPanel` class, `panelOptions`, `framePanel`, `OVERVIEW_WIDGET`, `PATHS_USAGE` — verbatim.
- `index.ts` final contents: pi/node type imports, `import { checkWriteEdit, checkBashCommand } from "./pipeline.ts"`, `import { GuardPanel, … } from "./panel.ts"`, `import { setMode, … } from "./rules.ts"`, and the verbatim `export default function (pi: ExtensionAPI)` body. Only this file has a default export.

- [ ] **Step 1: Move `checkWriteEdit` + `checkBashCommand` into `pipeline.ts`; wire imports.**

- [ ] **Step 2: Move the panel/menu/action blocks into `panel.ts`, switching any direct `extraProtected`/`trustedPaths`/`currentMode`/`config` access to the Task-4 accessors.**

- [ ] **Step 3: Shrink `index.ts` to the registration body; confirm `grep -c "export default" extensions/path-guard/*.ts` prints `1` (index only).**

- [ ] **Step 4: Run the suite — expected 328 passed. Panel + settings + mode tests included.**

- [ ] **Step 5: Line-count sanity check**

Run: `wc -l extensions/path-guard/*.ts`
Expected: ~4200 total lines across 9 files (verbatim move ⇒ total roughly unchanged), largest file ≤ ~1200.

- [ ] **Step 6: Commit** — `git commit -m "refactor: extract panel.ts and pipeline.ts; index.ts is now the thin entry"`

---

### Task 8: Docs + version 1.7.0

**Files:**
- Modify: `package.json` (version), `CHANGELOG.md` (new `## [1.7.0]` entry at top), `README.md` (two additions below), `extensions/path-guard/index.ts:1-5` (header comment "recent release/tag is 1.7.0")

- [ ] **Step 1: Bump `package.json` version to `1.7.0`; update header comment in `index.ts`.**

- [ ] **Step 2: CHANGELOG entry `## [1.7.0] — split into modules (no behavior change)`:** directory-form extension `extensions/path-guard/` with `index.ts` entry; module list (constants/escape/paths/rules/shell-parse/judges/panel/pipeline); all mutable state centralized in `rules.ts`; verbatim-move refactor verified by the unchanged 328-test suite.

- [ ] **Step 3: README — "已知边界 / Known limitations" section (bilingual, place near the capabilities section):** POSIX-only shell semantics (bash/zsh/sh family); no static evaluation of shell variables (unresolvable `$VAR` targets are treated conservatively); guard is an accident-prevention tool, not a sandbox against deliberate prompt-injection attacks; `/guard naked` deliberately disables protection.

- [ ] **Step 4: Run the suite one final time — expected 328 passed.**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: v1.7.0 — module split changelog, README known-limitations"
```

## Self-Review

- **Coverage:** P2 item "单文件拆分" → Tasks 1–7; "README 已知边界" → Task 8 Step 3. Audit log intentionally out of scope (user deferred). dd/curl & rsync/scp items were verified already-implemented in v1.6.3.
- **Placeholders:** Task 4 accessors and Task 7 panel conversion name the exact functions to create and which call sites change; all moved code is specified as "verbatim from survey line ranges" — the survey *is* the content (a verbatim move needs no rewritten code blocks; inventing them would risk drift).
- **Type consistency:** symbol names in every "Produces" list were grepped from the actual file (line numbers cited); accessor names (`getMode`, `addProtectedPath`, `addTrustedPath`, `removePath`, `clearPaths`) are introduced in Task 4 and consumed only in Task 7.
- **Review Focus → tasks:** circular imports (Tasks 2–7 each run the full suite immediately); missing exports (same); duplicated mutable state (Task 4 Step 3 names the failing test classes); stray extension file (Task 1 Step 3 + Task 7 Step 3 grep); panel regressions (Task 7 Step 4 explicitly includes panel tests).
