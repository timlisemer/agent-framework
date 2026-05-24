/**
 * Help documentation strings for MCP tools that do not have a dedicated `help`
 * action. These are exposed via MCP resources (see src/mcp/server.ts) so clients
 * calling `resources/list` + `resources/read` can discover each tool's contract.
 *
 * The two test-harness tools export their own help strings (TESTER_HELP,
 * LABELER_HELP) from their implementation files; this module covers the rest.
 */

export const CHECK_HELP = `# check -- Linter + Type-Check Summarizer

Runs the project's configured linter and check target (Justfile or Makefile),
classifies the output into errors/warnings/info, and returns a structured
summary. Does NOT read or analyze source code.

## Inputs

- working_dir (optional): directory to run in (defaults to cwd)
- transcript_path (optional): session transcript path, used only for statusLine

## Classification

- ERRORS: compile failures, type errors, syntax errors, UNUSED code
  (unused code is an error because it must be deleted, not suppressed)
- WARNINGS: style hints, lints, refactoring suggestions
- INFO: benchmark results, performance metrics, test summaries (max 5 lines)

## Output shape

\`\`\`
## Results
- Errors: <count>
- Warnings: <count>
- Status: PASS | FAIL

## Errors
<quoted errors>

## Warnings
<quoted warnings>

## Info
<benchmarks, max 5 lines>
\`\`\`

Status is FAIL if Errors > 0, PASS otherwise.

## When to use

- As the final gate before returning work to the user (per user instructions)
- Before running commit/confirm to fail fast on obvious errors
- Any time you want a summary of project health without touching source code`;

export const LOCATE_SCENARIO_HELP = `# locate_scenario -- Captured Scenario Locator

Locates a captured scenario from one or more distinctive quote substrings.
This replaces the manual \`scenarios/LOCATE-SCENARIO.md\` recipe up to the
materialization point.

## Inputs

- quotes (required): one or more quote substrings
- working_dir (optional): telemetry/context directory, defaults to cwd
- transcript_path (optional): session transcript path for statusLine

## Flow

1. Search raw Claude and Codex transcripts for each quote.
2. Search agent-framework \`tool-log.jsonl\`, \`captures.jsonl\`, and
   \`session-injections.jsonl\` for each quote.
3. Resolve raw transcript hits back to session directories through
   \`transcript-path.txt\` sidecars.
4. Cross-reference tool-log \`toolUseId\` and injection \`seq\` values against
   \`captures.jsonl\` where possible.
5. If no predefined search finds anything, return a user-facing failure notice
   plus manual fallback guidance.
6. If candidates are found, summarize them with a haiku-tier LLM and append
   required next-step instructions.

## Output

On success, returns \`## Findings\` plus instructions to notify the user and
only materialize through the active \`scenario_tester\` MCP if the user already
requested materialization.

On failure, returns \`## Locate Scenario Failed\`, the predefined commands tried,
and manual guidance for locating scenarios by transcript/session logs.`;

export const CONFIRM_HELP = `# confirm -- Code Quality Gate

Binary gate that evaluates uncommitted changes for quality, security, and
documentation. Runs check first; if check fails, confirm DECLINES immediately
without invoking an LLM.

## Inputs

- working_dir (optional): directory to evaluate (defaults to cwd)
- model_tier (optional): haiku | sonnet | opus (default opus)
- extra_context (optional): free-form additional instructions or review-depth guidance
- optional_planfile (optional): planfile path to include in confirm context
- skip_elicitation (optional, bool): skip interactive repo/preference prompts

## Flow

1. Detect repos with uncommitted changes via list_repos logic
2. If multiple repos and skip_elicitation=false, elicit selection via form
3. For each selected repo, optionally elicit model tier + confirm review depth
4. Resolve plan context from optional_planfile or the session current planfile.
   If neither exists, continue without plan input. If optional_planfile is
   provided but unreadable or empty, fail before check.
5. Run check agent. If it FAILs, DECLINE without LLM.
6. Otherwise, run the confirm SDK agent (Read + read-only Bash available)
7. On DECLINED with uncertainties, elicit clarification and retry once

## Output

One "## Verdict" block per repo: either CONFIRMED or DECLINED with reason.

## When to use

- Before commit, to decide if changes are worth committing
- As a standalone code review gate during development
- To get a structured quality/security/documentation verdict on a diff`;

export const COMMIT_HELP = `# commit -- Quality-Gated Git Commit

Runs confirm first; if CONFIRMED, generates a commit message sized to the diff
and executes git commit. Optionally auto-pushes after successful commits.

## Inputs

- working_dir (optional): directory to commit in (defaults to cwd)
- model_tier (optional): haiku | sonnet | opus (passed through to confirm)
- extra_context (optional): passed through to confirm
- optional_planfile (optional): passed through to confirm as plan context
- skip_elicitation (optional, bool): skip interactive prompts
- auto_push (optional, bool): push every successfully-committed repo after

## Flow

1. Detect repos with uncommitted changes
2. Elicit repo selection (if multiple + interactive)
3. Per repo: elicit preferences, run confirm agent
4. If CONFIRMED, generate message sized to diff:
   - SMALL (1-3 files, <50 lines): single lowercase line
   - MEDIUM (4-10 files or 50-200 lines): scope-prefixed line
   - LARGE (10+ files or 200+ lines): title + bullet body
5. Execute git add -A && git commit
6. If auto_push, elicit push selection and run push agent per repo

## Output

Per-repo results with commit hash on success, DECLINED reason on failure.

## When to use

- End of a unit of work, when the user explicitly asks you to commit
- Never proactively -- only on explicit user request`;

export const PUSH_HELP = `# push -- Git Push to Remote

Simple wrapper around \`git push\`. Does NOT invoke an LLM and does NOT run
through the confirm/check chain -- pushing is a locally non-destructive
operation.

## Inputs

- working_dir (optional): directory to push from (defaults to cwd)
- skip_elicitation (optional, bool): push all detected repos without prompting

## Flow

1. Detect repos (reposWithChanges as starting set)
2. If no repos have changes, just push the working dir
3. If multiple repos + interactive, elicit which to push
4. For each repo, run \`git push\` in its cwd

## Output

Remote's push output or \`ERROR: <message>\` per repo.

## When to use

- After a successful commit, when the user explicitly wants changes pushed
- Standalone to catch up an already-committed branch
- Never proactively -- only on explicit user request`;

export const LIST_REPOS_HELP = `# list_repos -- Repo + Submodule Status

Lists the main repo plus every submodule, with a flag for each indicating
whether it has uncommitted changes. Use this before confirm/commit/push to
understand what repos are in play.

## Inputs

- working_dir (optional): directory to inspect (defaults to cwd)

## Output

Plain text with three sections:

\`\`\`
MAIN REPO: <absolute path>
  Name: <basename>
  Has changes: YES|NO

SUBMODULES:
  - <relative path>
    Absolute path: <absolute>
    Has changes: YES|NO

REPOS WITH UNCOMMITTED CHANGES:
  - <name>: <absolute path>
\`\`\`

## When to use

- As a read-only preflight before any multi-repo operation
- To answer "what repos does this working tree contain?"
- To decide whether commit/confirm is needed at all (skip if no changes)`;

export const VALIDATE_INTENT_HELP = `# validate_intent -- User Intention Alignment Check

Analyzes the session transcript, uncommitted changes, and plan file (if any)
to decide whether the AI's work aligns with what the user actually asked for.

## Inputs

- working_dir (optional): directory whose changes to inspect (defaults to cwd)
- transcript_path (REQUIRED): absolute path to the conversation transcript
  jsonl file

## Flow

1. Read transcript via the transcript preset (head/tail sampling)
2. Gather git status + diff for working_dir
3. Load plan content if a plan file exists
4. Run the validate-intent agent with transcript + diff + plan
5. Return ALIGNED or DRIFTED with reason

## Output

Structured verdict with ALIGNED or DRIFTED verdict and a short reason.

## When to use

- Before committing a large change, to catch scope creep
- As a stop-hook check to detect drift from user intent
- Any time you want an independent second opinion on "did I do the right thing"`;

export const VALIDATE_PLAN_HELP = `# validate_plan -- Plan Contract Validator

Validates a plan file against the planning contract using the
plan-validate agent. This validates the plan itself, not user-intent alignment.

## Inputs

- working_dir (optional): directory whose planning contract applies (defaults to cwd)
- plan_file (required): path to a plan file to validate
- transcript_path (optional): session transcript path, used only for statusLine

plan_file is required.

## Output shape

\`\`\`
## Results
- Status: PASS | FAIL

## Reasons
<concrete validation reasons on FAIL>

## Instructions
<present the validated planfile on PASS, or iterate on the planfile until it passes on FAIL>
\`\`\`

## When to use

- When a validation failure tells the agent to iterate on an existing planfile
- For explicit manual revalidation of an existing named planfile
- Any time an agent wants to check whether an existing planfile is structurally valid and implementation-ready`;

export const CREATE_PLANFILE_HELP = `# create_planfile -- Planfile Creator

Creates the current session planfile for a lowercase kebab-case plan name, then validates it.

## Inputs

- plan_name (required): lowercase kebab-case plan name
- content (required): final plan body/content

The tool resolves the current session through the shared agent-framework session resolver, creates the file, normalizes the Plan Name header and Planfile Path footer, and returns the validate_plan result for the written file. MCP calls without an explicit transcript path use the latest transcript-path.txt sidecar for the active project.

## When to use

- During plan1/plan3/plan5 consolidation
- When creating the named planfile from consolidated planner output`;

export const TRANSCRIPT_HELP = `# transcript -- Session Transcript Path Resolver

Returns the absolute path to the current agent session's transcript .jsonl file and refreshes the transcript-path.txt sidecar under ~/.agent-framework/sessions/.

## Inputs

- transcript_path (optional): explicit transcript file path. Omit to use the shared session resolver and read the most recent transcript-path.txt sidecar under ~/.agent-framework/sessions/<project>/.

## Output

The absolute path to the transcript file as a plain string.

## When to use

- Via the /transcript slash command to get the current session's transcript path
- When you need to pass a session folder name to scenario_labeler scaffold or list and want the sidecar to be up-to-date`;
