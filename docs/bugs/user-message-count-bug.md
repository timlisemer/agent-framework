# Bug: Error-acknowledge sees old user messages despite user: 1

## Observed Behavior

The error-acknowledge hook blocked a tool call quoting an OLD user directive, even though:
1. `ERROR_CHECK_COUNTS` is set to `{ user: 1, assistant: 1, toolResult: 2 }`
2. A MORE RECENT user text message existed in the conversation

## Timeline Analysis

The conversation had this structure:
1. User sends text message A (a directive)
2. AI performs multiple tool calls addressing the directive (websearch, grep, read, write)
3. User answers an AskUserQuestion (tool result, not text)
4. User approves ExitPlanMode (tool result, not text)
5. User sends text message B (new request)
6. AI attempts Edit tool
7. **Hook blocks quoting message A, not message B**

## Key Observation

Between user text message A and user text message B:
- Multiple AI tool calls occurred
- User interactions via AskUserQuestion and ExitPlanMode occurred
- These interactions are stored as `tool_result` blocks, NOT user text messages

With `user: 1`, the transcript reader should find message B (most recent user text). But it found message A instead.

## Root Cause Found

**Location:** `src/utils/transcript.ts` lines 641, 680

**The Bug:** Array built with `unshift()` but accessed as if built with `push()`

- Lines 641 and 680 use `unshift()` to prepend messages
- `unshift()` creates array ordered: [newest, older, oldest]
- Callers use `array[array.length - 1]` expecting newest at end
- Result: `array[length - 1]` returns OLDEST message, not newest

## Code References

```typescript
// Line 641 - string user content
collected.user.unshift({ role: 'user', content: msgContent, index: lineIndex });

// Line 680 - text block user content
collected.user.unshift({ role: 'user', content: block.text, index: lineIndex });

// Line 530 - assistant (same bug pattern)
collected.assistant.unshift({ role: 'assistant', content: text, index: i });

// Line 670 - toolResult (same bug pattern)
collected.toolResult.unshift({ role: 'tool_result', content: toolContent, index: lineIndex });
```

## Why It Appeared Correct Before

With higher counts (e.g., `user: 3`), the array contained multiple messages and `formatTranscriptResult` sorted by index. The bug only manifests when:
1. Count is low (e.g., `user: 1`)
2. Code accesses array directly without sorting

## Fix Options

1. **Change `unshift()` to `push()`** - Build array in expected order
2. **Change array access** - Use index 0 instead of length-1
3. **Always sort before access** - Ensure consistent ordering

## Affected Code

- `src/utils/transcript.ts` lines 530, 641, 670, 680
- Any caller that accesses arrays directly without sorting
