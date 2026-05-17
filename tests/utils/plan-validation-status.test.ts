import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  hashPlanContent,
  planValidationStatusKey,
  readPlanValidationStatus,
  recordPlanValidationStatus,
} from "../../src/utils/plan-validation-status.js";

describe("plan validation status", () => {
  it("keys records by resolved path and exact content hash", () => {
    const hash = hashPlanContent("plan");
    expect(hash).toHaveLength(64);
    expect(planValidationStatusKey("/tmp/plan.md", hash)).toBe(`${path.resolve("/tmp/plan.md")}#${hash}`);
  });

  it("records and reads pass records", () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-status-"));
    try {
      const planPath = path.join(sessionDir, "plans", "a.md");
      const contentHash = hashPlanContent("a");
      recordPlanValidationStatus({ sessionDir, planPath, contentHash, status: "pass", reasons: [] });
      expect(readPlanValidationStatus({ sessionDir, planPath, contentHash })).toMatchObject({
        status: "pass",
        planPath: path.resolve(planPath),
        contentHash,
        reasons: [],
      });
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("records and reads fail records", () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-status-"));
    try {
      const planPath = path.join(sessionDir, "plans", "a.md");
      const contentHash = hashPlanContent("a");
      recordPlanValidationStatus({ sessionDir, planPath, contentHash, status: "fail", reasons: ["bad"] });
      expect(readPlanValidationStatus({ sessionDir, planPath, contentHash })).toMatchObject({
        status: "fail",
        reasons: ["bad"],
      });
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("distinguishes exact hashes and paths", () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-status-"));
    try {
      const planPath = path.join(sessionDir, "plans", "a.md");
      const contentHash = hashPlanContent("a");
      recordPlanValidationStatus({ sessionDir, planPath, contentHash, status: "pass", reasons: [] });
      expect(readPlanValidationStatus({ sessionDir, planPath, contentHash: hashPlanContent("b") })).toBeNull();
      expect(readPlanValidationStatus({
        sessionDir,
        planPath: path.join(sessionDir, "plans", "b.md"),
        contentHash,
      })).toBeNull();
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});
