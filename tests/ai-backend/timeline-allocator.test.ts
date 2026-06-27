import { describe, expect, it } from "vitest";
import {
  AiTimelineInvariantError,
  TimelineAllocator,
} from "../../src/ai-backend/timeline-allocator.js";
import {
  backendProcessFixture as backendProcess,
  toolCallFixture as toolCall,
  transcriptEntryFixture as transcriptEntry,
} from "../helpers/ai-backend-fixtures.js";

describe("AI timeline allocator", () => {
  it("seeds public ids and visible sequence ids from hydrated rows", () => {
    const allocator = new TimelineAllocator();
    const hydrated = allocator.canonicalizeHydrated({
      transcript: [
        transcriptEntry({ id: "message-7", sequenceId: 4, createdAt: "2026-06-20T10:01:00.000Z" }),
        transcriptEntry({ id: "history-message-1", createdAt: "2026-06-20T10:00:00.000Z" }),
      ],
      toolCalls: [
        toolCall({ id: "tool-3", sequenceId: 8, createdAt: "2026-06-20T10:02:00.000Z" }),
      ],
      backendProcesses: [
        backendProcess({ id: "process-5" }),
      ],
      lastTimelineSeq: 8,
    });

    expect(hydrated.transcript.map((entry) => entry.sequenceId)).toEqual([4, 9]);
    expect(hydrated.toolCalls.map((entry) => entry.sequenceId)).toEqual([8]);
    expect(allocator.nextMessageId()).toBe("message-8");
    expect(allocator.nextToolId()).toBe("tool-4");
    expect(allocator.nextProcessId()).toBe("process-6");
    expect(allocator.nextTimelineSeq()).toBe(10);
  });

  it("assigns missing hydrated sequences by input order", () => {
    const allocator = new TimelineAllocator();
    const hydrated = allocator.canonicalizeHydrated({
      transcript: [
        transcriptEntry({ id: "history-message-1", createdAt: "2026-06-20T10:02:00.000Z" }),
        transcriptEntry({ id: "history-message-2", createdAt: "2026-06-20T10:01:00.000Z" }),
      ],
      toolCalls: [
        toolCall({ id: "call-1", createdAt: "2026-06-20T10:01:30.000Z" }),
      ],
    });

    expect(hydrated.transcript.map((entry) => [entry.id, entry.sequenceId])).toEqual([
      ["history-message-1", 1],
      ["history-message-2", 2],
    ]);
    expect(hydrated.toolCalls.map((tool) => [tool.id, tool.sequenceId])).toEqual([["call-1", 3]]);
  });

  it("rejects duplicate public ids and duplicate visible sequence ids", () => {
    expect(() =>
      new TimelineAllocator().canonicalizeHydrated({
        transcript: [
          transcriptEntry({ id: "message-1", sequenceId: 1 }),
          transcriptEntry({ id: "message-1", sequenceId: 2 }),
        ],
      })
    ).toThrow(AiTimelineInvariantError);

    expect(() =>
      new TimelineAllocator().canonicalizeHydrated({
        transcript: [transcriptEntry({ id: "message-1", sequenceId: 1 })],
        toolCalls: [toolCall({ id: "tool-1", sequenceId: 1 })],
      })
    ).toThrow(AiTimelineInvariantError);
  });
});
