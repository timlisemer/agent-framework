# Scenario System

The scenario system has one generic command/event protocol and one runtime.
Provider callbacks, the gateway, and fixture execution dispatch shared commands
directly. Native Agent Framework hooks are application behavior: the host
entrypoint wraps them in the protocol's opaque `extensionCommand`, and the
injected handler under `effects/` projects their state, records, and effects.

## Modules

| Module | Purpose |
|---|---|
| `protocol/` | Command, record, snapshot, feedback, gateway, and generated schemas |
| `runtime/` | Reusable transactional dispatch, reduction, effect lifecycle, and authorization mechanics |
| `../effects/` | Agent Framework hook extension, rule execution, workflow schemas, state policy, and fixture policy |
| `../entrypoints/native-transcript.ts` | Agent Framework adapter selection and native transcript normalization before canonical dispatch |
| `store/` | Append-only journal, snapshots, artifacts, feedback, manifests, and run registry |
| `fixtures/` | Fixture validation, execution, and materialization |
| `../agents/mcp/scenario-catalog.ts` | Application-owned fixture discovery under the configured scenario roots |
| `contract-cli.ts` | Stable compiled schema export, generic command replay, materialization, and snapshot validation for external consumers |

## Runtime and storage

Every accepted command produces one immutable record batch, encoded as one
JSON array line in `scenario.records.jsonl`. The reducer applies that batch to
`scenario.snapshot.json`; recovery truncates an incomplete final array line in
full, so no prefix of a command batch is authoritative. No boundary adapter or
sidecar authors semantic run state. Durable runs live under
`<runtime-root>/runs/<run-id>/` and are indexed by the run registry. The generic
runtime and stores require that root explicitly. Agent Framework's production
composition applies its environment override or the default
`~/.agent-framework` root in `createAgentFrameworkScenarioRuntime`.

Effects use the journal as a durable outbox. The `effect.requested` record and
its pre-effect journal cursor reconstruct executor inputs after a command retry
or process restart, including artifact-backed values. `effect.started` carries
an expiring claim ID; recovery atomically replaces an expired claim, and every
progress or terminal command must present the current claim. This prevents a
stale worker from publishing a second terminal result. Normal dispatch drains
the outbox, while startup/resume integrations can call
`recoverPendingEffects(runId)` explicitly.
Progress is an opaque `effectProgressed` payload reduced to
`effect.progressed`; the generic protocol does not define application progress
semantics. Agent Framework projects its rule registry and evaluations through
the `rule.pipeline` state slice and `agent-framework.rule-pipeline` extension
records, while gate and appeal details remain application-owned extension data.

Canonical reads can repair journals, snapshots, manifests, artifacts, and lock
diagnostics. `ScenarioRuntime` publishes every record batch committed by such a
read before returning the repaired view, so existing subscribers observe the
same contiguous sequence and revisions as later command publications.

The reusable runtime treats state-slice keys and values and extension data as
opaque protocol data. `createAgentFrameworkScenarioRuntime` injects the Agent
Framework command-extension handler and state policy. Those components project
host boundary state, normalize workflow values, merge concurrent workflow and
gate history updates, and emit the initial application slice catalog as
explicit `state.sliceChanged` records. Generic consumers can omit them or
supply their own without importing Agent Framework hook, rule, or workflow
types. The generated cross-repository contract therefore exposes only
`extensionCommand` and `extension.observed`, not Agent Framework hook variants
or hook/rule event names. Adapter-native transcripts are likewise normalized
by the Agent Framework entrypoint; the reusable runtime accepts only the
already-normalized `nativeTranscriptObserved` command data.

The generic gateway carries provider settings through an open
`sdkRuntimeEnvironment` identifier, a `{ kind, configuration }` runtime-home
descriptor, and a `{ sdkRuntime, nativeSessionId }` resume target. It does not
encode Agent Framework's supported SDKs, environments, profiles, or native ID
field names. The composing provider host validates those policies, then records
the initial selection and every resume transition in `provider.stateObserved`;
system prompts are stored as digests rather than plaintext. The journal is
therefore authoritative for which configuration produced each resumed segment
of a run.

Provider cancellation aborts the active turn and gives both turn settlement
and runner disposal a bounded cleanup window. A non-cooperative provider is
detached so late events cannot mutate the run, the canonical run is cancelled
so a continuable session can resume through a fresh manager, and the timeout is
persisted in recovery diagnostics with source `providerShutdown`.
Tool decisions are committed canonically before the provider waiter is woken.
If that coordination unexpectedly throws, the gateway performs whole-run
cancellation so authorization waiters are rejected, pending tools are
terminalized, and no further input can reach the detached provider.

Hosts that expose conversation history only through a native transcript parse
one stabilized observation with the active adapter and dispatch
`nativeTranscriptObserved`. The application derives adapter metadata such as
parallel batches from that same parse and persists the rule-facing projection
in `host.context`; no hook performs a second semantic transcript read. The
parsed messages and tool calls are projected into canonical `conversation` and
`toolCalls`. Each observation replaces the active native projection: entries
missing after compaction, clear, or rewind receive `message.retired` or
`tool.retired` journal records and are removed from the reduced snapshot used by
rules. Their earlier records remain auditable in the append-only journal. The
`transcript.native` state slice stores the imported digest, active canonical
entity IDs, and native-to-canonical tool aliases used to avoid redundant
observations and identify the next replacement.
Terminal tools first recorded by host PreToolUse/PostToolUse are claimed by ID,
or by a unique unclaimed name-and-input identity when the native transcript
later includes them. Ambiguous identities are rejected. Claiming adds
them to the active native projection without duplicating terminal lifecycle
records, so later compaction retires them through the same replacement path.

## Fixtures

Fixtures live under `scenarios/` and use one schema. The generic
`fixtures/runner.ts` dispatches commands through `ScenarioRuntime` and evaluates
record, snapshot, and command-result expectations. Runner and materializer both
accept an optional `ScenarioFixturePolicy`; this is the sole injection boundary
for an extension handler, effect planner, state-slice policy, live-behavior
classification, expectation projection, and deterministic effect projection.
Without a policy, extension data and effects remain opaque.

Agent Framework supplies its policy from
`../effects/scenario-fixture-policy.ts`, and `scenario_tester` injects it explicitly.
Its deterministic fixtures author effect results only for
journal/reducer/recovery mechanics. Live rule fixtures dispatch canonical host
commands and execute `RulePipelineEffectExecutor`; they must assert actual rule
evaluations and resulting workflow state instead of supplying the decision
under test.

The standard fixture groups are:

- `expected-to-pass/` for required passing coverage
- `non-deterministic/` for scenarios that need repeated-run evidence
- `expected-to-fail/` for intentional known-gap coverage

`snapshotOneOf`, `snapshotStringContains`, and `snapshotArrayMinLength`
expectations support live classification and rule-trace assertions. Their paths
may use JSON Pointer syntax when a state-slice key contains a dot, for example
`/stateSlices/session.workflow/value/currentPrediction/mood`.

Use the `scenario_tester` MCP for fixture operations:

- `list_fixtures` and `read_fixture` inspect committed fixtures.
- `run_fixture` and `run_fixtures` execute them.
- `materialize_scenario` converts a canonical run into a fixture by `run_id`.
- `inspect_report` reads stored execution reports.

Materialization reads the canonical run journal and snapshot directly. Through
the Agent Framework policy, `scenario_tester` classifies host behavior as live
and projects stable command-result, executor, and rule-evaluation expectations;
generic effect/recovery runs materialize deterministic terminal evidence. The
generic contract CLI does not import or interpret that policy: it preserves
extension commands and records as opaque protocol data. Manual feedback remains
append-only run data and never becomes a fixture expectation.

Cross-repository consumers must build the package and use the compiled contract
CLI instead of importing test helpers, generated source directories, or
TypeScript source paths. Consumers own their acceptance commands, fixture
identifiers, and any extension-aware fixture policy. The contract CLI validates
and executes only the generic protocol:

```bash
npm run build
npm run --silent scenario:contract -- export-schema <directory>
npm run --silent scenario:contract -- apply-commands <run-root> <commands-path>
npm run --silent scenario:contract -- materialize <run-root> <run-id> <name>
npm run --silent scenario:contract -- validate-snapshot <snapshot-path>
```

`apply-commands` is explicit-command replay: it validates and commits only the
commands present in the input array, in order. It does not run effect executors
or synthesize outbox lifecycle commands. A replay that includes
`requestEffect` must therefore also include its recorded `effectStarted` and
terminal effect command when a terminal snapshot is required. Normal production
`ScenarioRuntime.dispatch` continues to claim and drain pending effects
automatically.
