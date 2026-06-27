import {
  findExistingAgentFrameworkSessionDirForTranscript,
  getAgentFrameworkSessionDir,
} from "../utils/paths.js";

export function resolveTranscriptProjectionSessionDir(input: {
  transcriptPath: string;
  workingDir?: string | null;
  create?: boolean;
}): string | null {
  const projectDir = input.workingDir ?? undefined;
  const existing = findExistingAgentFrameworkSessionDirForTranscript({
    transcriptPath: input.transcriptPath,
    projectDir,
  });
  if (existing || input.create === false) return existing;
  return getAgentFrameworkSessionDir({
    transcriptPath: input.transcriptPath,
    projectDir,
  });
}
