import type { ScenarioRecord } from "../protocol/records.js";
import type { ScenarioSnapshot } from "../protocol/snapshot.js";
import type {
  FixtureExpectation,
  FixtureExpectationResult,
  ScenarioFixture,
} from "./types.js";
import { scenarioFixtureSchema } from "./types.js";
import { isRecord } from "../../utils/output.js";
import { toJsonValue } from "../protocol/common.js";
import { digestScenarioValue } from "../protocol/digest.js";
import { artifactDigestFromValue } from "../protocol/artifacts.js";
import { canonicalJsonEqual } from "../protocol/canonical-json.js";

export function validateScenarioFixture(input: unknown): ScenarioFixture {
  return scenarioFixtureSchema.parse(input);
}

export function evaluateFixtureExpectations(
  expectations: readonly FixtureExpectation[],
  records: readonly ScenarioRecord[],
  snapshot: ScenarioSnapshot,
): FixtureExpectationResult[] {
  return expectations.map((expectation) => {
    switch (expectation.kind) {
      case "record": {
        const matches = records.filter((record) => recordMatches(record, expectation));
        const pass = matches.length === expectation.count;
        return {
          expectation,
          pass,
          message: pass
            ? `matched ${matches.length} record(s)`
            : `expected ${expectation.count} matching record(s), found ${matches.length}`,
        };
      }
      case "absentRecord": {
        const count = records.filter((record) => record.eventType === expectation.eventType).length;
        return {
          expectation,
          pass: count === 0,
          message: count === 0 ? "record is absent" : `found ${count} unexpected record(s)`,
        };
      }
      case "commandResult": {
        const value = snapshot.commandResults[expectation.commandId];
        const result = isRecord(value) ? value : {};
        const statusPass = result.status === expectation.status;
        const reasonPass = expectation.reasonContains === undefined ||
          (typeof result.reason === "string" && result.reason.includes(expectation.reasonContains));
        const pass = statusPass && reasonPass;
        return {
          expectation,
          pass,
          message: pass
            ? `command returned ${expectation.status}`
            : `command result was ${JSON.stringify(value)}`,
        };
      }
      case "snapshot": {
        const actual = valueAtPath(snapshot, expectation.path);
        const pass = canonicalJsonEqual(actual, expectation.equals);
        return {
          expectation,
          pass,
          message: pass
            ? `snapshot.${expectation.path} matched`
            : `snapshot.${expectation.path} was ${JSON.stringify(actual)}`,
        };
      }
      case "snapshotOneOf": {
        const actual = valueAtPath(snapshot, expectation.path);
        const pass = expectation.values.some((value) => canonicalJsonEqual(actual, value));
        return {
          expectation,
          pass,
          message: pass
            ? `snapshot.${expectation.path} matched an allowed value`
            : `snapshot.${expectation.path} was ${JSON.stringify(actual)}`,
        };
      }
      case "snapshotStringContains": {
        const actual = valueAtPath(snapshot, expectation.path);
        const pass = typeof actual === "string" && actual.includes(expectation.value);
        return {
          expectation,
          pass,
          message: pass
            ? `snapshot.${expectation.path} contained ${JSON.stringify(expectation.value)}`
            : `snapshot.${expectation.path} was ${JSON.stringify(actual)}`,
        };
      }
      case "snapshotArrayMinLength": {
        const actual = valueAtPath(snapshot, expectation.path);
        const pass = Array.isArray(actual) && actual.length >= expectation.minLength;
        return {
          expectation,
          pass,
          message: pass
            ? `snapshot.${expectation.path} contained at least ${expectation.minLength} item(s)`
            : `snapshot.${expectation.path} was ${JSON.stringify(actual)}`,
        };
      }
    }
  });
}

function recordMatches(
  record: ScenarioRecord,
  expectation: Extract<FixtureExpectation, { kind: "record" }>,
): boolean {
  if (expectation.eventType !== undefined && record.eventType !== expectation.eventType) return false;
  if (expectation.commandId !== undefined && record.commandId !== expectation.commandId) return false;
  if (expectation.entityKind !== undefined && record.entityRef?.kind !== expectation.entityKind) return false;
  if (expectation.entityId !== undefined && record.entityRef?.id !== expectation.entityId) return false;
  return expectation.payloadContains === undefined || contains(record.payload, expectation.payloadContains);
}

function contains(actual: unknown, expected: unknown): boolean {
  const digest = artifactDigestFromValue(actual);
  if (digest !== undefined && digestScenarioValue(toJsonValue(expected)) === digest) return true;
  if (!isRecord(expected)) return canonicalJsonEqual(actual, expected);
  if (!isRecord(actual)) return false;
  return Object.entries(expected).every(([key, value]) => contains(actual[key], value));
}

function valueAtPath(root: unknown, path: string): unknown {
  const parts = path.startsWith("/")
    ? path.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    : path.split(".");
  return parts.reduce<unknown>((value, part) => {
    if (Array.isArray(value) && /^\d+$/.test(part)) return value[Number(part)];
    return isRecord(value) ? value[part] : undefined;
  }, root);
}
