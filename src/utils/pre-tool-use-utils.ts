import { appealDenial } from '../agents/hooks/tool-appeal.js';
import { logToHomeAssistant } from './logger.js';
import { readTranscriptExact, formatTranscriptResult } from './transcript.js';
import { APPEAL_COUNTS } from './transcript-presets.js';

export interface CheckResult {
  approved: boolean;
  reason?: string;
}

export async function checkWithAppeal(
  check: () => Promise<CheckResult>,
  toolName: string,
  toolInput: unknown,
  transcriptPath: string,
  onAppealSuccess?: () => void
): Promise<CheckResult> {
  const result = await check();

  if (result.approved) {
    return result;
  }

  // Appeal the denial
  const transcriptResult = await readTranscriptExact(transcriptPath, APPEAL_COUNTS);
  const transcript = formatTranscriptResult(transcriptResult);
  const appeal = await appealDenial(
    toolName,
    toolInput,
    transcript,
    result.reason || 'No reason provided'
  );

  const toolDescription = `${toolName} with ${JSON.stringify(toolInput).slice(0, 100)}`;

  if (appeal.approved) {
    await logToHomeAssistant({
      agent: 'check-with-appeal',
      level: 'decision',
      problem: toolDescription,
      answer: 'APPEALED',
    });
    onAppealSuccess?.();
    return { approved: true };
  }

  return { approved: false, reason: appeal.reason ?? result.reason };
}
