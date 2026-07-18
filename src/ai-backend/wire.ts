import { stdin as processStdin, stdout as processStdout } from "node:process";
import {
  scenarioClientFrameSchema,
  type ScenarioBackendFrame,
  type ScenarioClientFrame,
} from "../scenario/protocol/gateway.js";
import { jsonStringifyWithBigint } from "../utils/json.js";
import { MAXIMUM_CLIENT_FRAME_BYTES } from "../scenario/protocol/limits.js";

interface JsonlWritable {
  write(chunk: string): unknown;
}

export function parseClientFrame(line: string): ScenarioClientFrame {
  const parsed = JSON.parse(line) as unknown;
  return scenarioClientFrameSchema.parse(parsed);
}

export function writeBackendFrame(
  frame: ScenarioBackendFrame,
  stdout: JsonlWritable = processStdout,
): void {
  stdout.write(`${jsonStringifyWithBigint(frame)}\n`);
}

export async function readClientFrames(
  onFrame: (frame: ScenarioClientFrame) => void | Promise<void>,
  input: NodeJS.ReadableStream = processStdin,
  onError?: (error: unknown) => void | Promise<void>
): Promise<void> {
  let segments: Buffer[] = [];
  let bufferedBytes = 0;
  let discardingOversizedFrame = false;

  const reportFrameError = async (error: unknown): Promise<void> => {
    if (!onError) throw error;
    await onError(error);
  };
  const processBufferedFrame = async (): Promise<void> => {
    const bytes = Buffer.concat(segments, bufferedBytes);
    segments = [];
    bufferedBytes = 0;
    const line = bytes.at(-1) === 0x0d ? bytes.subarray(0, -1).toString("utf8") : bytes.toString("utf8");
    if (!line.trim()) return;
    let frame: ScenarioClientFrame;
    try {
      frame = parseClientFrame(line);
    } catch (error) {
      await reportFrameError(error);
      return;
    }
    await onFrame(frame);
  };

  for await (const chunk of input as AsyncIterable<Buffer | string>) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline === -1 ? bytes.length : newline;
      if (discardingOversizedFrame) {
        if (newline === -1) break;
        discardingOversizedFrame = false;
        offset = newline + 1;
        continue;
      }

      const segment = bytes.subarray(offset, end);
      if (bufferedBytes + segment.byteLength > MAXIMUM_CLIENT_FRAME_BYTES) {
        segments = [];
        bufferedBytes = 0;
        discardingOversizedFrame = newline === -1;
        await reportFrameError(new Error("Client frame exceeds maximum size"));
        if (newline === -1) break;
        offset = newline + 1;
        continue;
      }
      if (segment.byteLength > 0) {
        segments.push(segment);
        bufferedBytes += segment.byteLength;
      }
      if (newline === -1) break;
      await processBufferedFrame();
      offset = newline + 1;
    }
  }
  if (!discardingOversizedFrame && bufferedBytes > 0) await processBufferedFrame();
}
