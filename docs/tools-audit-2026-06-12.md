# Tools Audit (B-D3, 2026-06-12)

> Last refreshed: **2026-06-12**.
> Companion to bscode's [README.md](../README.md), agentkit-js's
> [ROADMAP.md](https://github.com/telleroutlook/agentkit-js/blob/main/ROADMAP.md)
> S4, and the *generic-first* discipline section in agentkit-js's
> [CONTRIBUTING.md](https://github.com/telleroutlook/agentkit-js/blob/main/CONTRIBUTING.md).

This document applies the three-question test from CONTRIBUTING to
every tool currently shipped under `apps/worker/src/tools/`. The
question set:

1. *Is the logic specific to this product, or would another agent
   project want it?*
2. *Does it depend only on already-published `@agentkit-js/*` APIs?*
3. *Is there a comparable feature already in `agentkit-js` you would
   otherwise duplicate?*

If the answer to (1) is "another project would want it" the logic
**must** land in `agentkit-js` first; bscode then consumes the
published API. The audit below is the public reasoning trail —
keep it honest, refresh it when tools change.

## Verdict at a glance

| Tool                                | File                          | Verdict       | Notes                                                                         |
|-------------------------------------|-------------------------------|---------------|-------------------------------------------------------------------------------|
| `semantic_search` + indexer         | `semanticSearch.ts`           | UPLIFT        | TF-IDF over `InMemoryVectorStore` is generic; belongs in `@agentkit-js/tools-rag` |
| `init_agents_md`                    | `agentsMd.ts`                 | KEEP          | Template-scaffolding for the bscode UX; not generic                           |
| `read_build_result` / writer        | `build-result.ts`             | KEEP          | bscode-specific build cache (WebContainer ↔ worker bridge)                    |
| `import_github_repo`                | `githubImport.ts`             | UPLIFT        | Generic GitHub-tree importer; belongs in a new `@agentkit-js/tools-github`    |
| `create_github_pr`                  | `githubPr.ts`                 | UPLIFT        | Generic PR opener; same `@agentkit-js/tools-github` package as the importer   |
| `revert_file` + `list_file_versions`| `revert.ts` / `app.ts` wiring | EVALUATE      | The version primitive is in `core/workspace/FileTreeManager`; the *tool* could move to a generic `tools-workspace` |
| `visual_verify` / `visual_interact` | `visual.ts`                   | PARTIAL       | Browser navigation + screenshot path is generic (could land in `@agentkit-js/tools-browser`); the **vision-judge** scoring is product-shaped (depends on bscode's intent vocabulary) |
| `web_search` factory                | `web-search.ts`               | KEEP          | Already a thin wrapper around `@agentkit-js/tools-web`; nothing else to lift  |
| Git tools (`createGitTools`)        | `shell.ts`                    | KEEP          | Wraps `Bun.spawn` — Node/Bun-only by design; pairs with `enableShell`         |

## Reasoning — UPLIFT items

### `semantic_search` + indexer → `@agentkit-js/tools-rag`

The implementation in `semanticSearch.ts` is a bscode-named wrapper
around `InMemoryVectorStore` from `@agentkit-js/tools-rag`. The
TF-IDF path that deduplicates against existing entries, batches
embeddings, and exposes a `ToolDefinition` with a stable input shape
is the *exact* shape any agent project that wants in-memory RAG would
build. Lift the TF-IDF tool factory into `tools-rag`; bscode then
keeps a 5-line `createSemanticSearchTool({ indexer, fileTree })`
adapter that wires it to the bscode `FileTreeManager`.

**Migration sketch:**

- New export from `@agentkit-js/tools-rag`:
  `createTfidfSearchTool({ indexer, getCorpus, k })` returning a
  `ToolDefinition`.
- bscode keeps the `SemanticIndexer` adapter (it knows how bscode's
  files mutate) and calls `createTfidfSearchTool` with its indexer.

### `import_github_repo` + `create_github_pr` → `@agentkit-js/tools-github` (NEW)

Both files are pure REST + `agentkit-js/core` `ToolDefinition`. They
do not depend on any bscode primitive other than its `KvStore`,
which is itself a thin wrapper around `core`'s `KvBackend`. Any agent
project that wants to read a GitHub repo into its workspace or open
a PR against the user's fork would copy these files verbatim today —
that's the textbook duplication signal.

**Migration sketch:**

- New package: `packages/tools-github/`.
- Exports: `importGithubRepo()` and `createGitHubPrTool()`, both
  parameterized over `KvBackend` (already public) instead of
  bscode's `KvStore`.
- bscode imports from `@agentkit-js/tools-github` instead of
  `./tools/githubImport.js` / `./tools/githubPr.js`.

### `visual_verify` (browser-nav part) → `@agentkit-js/tools-browser`

The "navigate to a URL, take a screenshot, run a selector probe"
path inside `visual.ts` mirrors what `tools-browser` already does
for headless Chromium. The bscode-specific bit is the **vision
judge** — it consumes a bscode-defined "intent" vocabulary that
spans the agent's framework-mode output. Split:

- The browser-nav primitives → `@agentkit-js/tools-browser`
  (extends the existing surface).
- The intent-aware vision judge stays in bscode (`apps/worker/src/visionJudge.ts`)
  because its vocabulary is product-shaped.

**Migration sketch:**

- `tools-browser` adds `createVisualVerifyTool({ browser, store })`
  returning the navigate+probe ToolDefinition.
- bscode's `createVisualVerifyTool` becomes a 10-line adapter that
  layers the vision judge on top.

## Reasoning — KEEP items

### `init_agents_md`, `read_build_result` writer, `web_search`, git tools

These are either thin wrappers around already-generic agentkit APIs
(`web_search` over `tools-web`, git tools over `Bun.spawn`) or they
encode product-shaped UX (the AGENTS.md scaffold's prompt vocabulary
is bscode-specific; the build-result cache is the
WebContainer-to-worker bridge bscode owns). Leave them.

## Reasoning — EVALUATE: `revert_file` + `list_file_versions`

`FileTreeManager` already lives in `@agentkit-js/core/workspace`
and exposes the per-file version history; bscode's `revert_file`
tool is a pure adapter on top of it. The tool itself is small enough
that lifting it into `core/workspace` (as a `ToolDefinition` factory)
would mainly save bscode 50 LOC. Marked EVALUATE rather than UPLIFT
because the call-site there is small and the user-facing benefit of
having one more tool factory in `core` is borderline.

**Decision rule:** if any other consumer (e.g., a Vercel AI SDK demo
or another agentkit consumer) wants the same revert UX, lift it.
Otherwise leave it where it is.

## Process going forward

The discipline rule in agentkit-js's CONTRIBUTING is the floor, not
the ceiling. New bscode PRs that add a tool MUST link to this audit
in their description and either:

- Cite an entry whose verdict is KEEP that justifies why the new
  tool is product-shaped, OR
- Open an issue in agentkit-js for the generic counterpart and
  reference its number, even if the bscode PR ships first as a
  sketch.

A PR that adds a generic-shaped tool to `bscode` without doing one
of the two above will be redirected, per CONTRIBUTING's
"Generic-first discipline (S4)" section.

## Refresh cadence

Refresh this file every quarter or whenever a tool moves from
EVALUATE → UPLIFT. Stale audits are worse than no audit because they
suggest the discipline is in place when it is not.
