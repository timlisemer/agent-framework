import { sessionToolLogFile } from "../utils/paths.js";
import { readToolLogEntries } from "../utils/session-store.js";
import { fileMtimeMs } from "../utils/file-io.js";
import { projectTranscriptLines, readRawTranscriptLines, type TranscriptProjection } from "./transcript-runtime.js";

export type LiveTranscriptWatcher = {
  poll(): TranscriptProjection | null;
  snapshot(): TranscriptProjection;
};

export function createLiveTranscriptWatcher(input: {
  adapterName: string;
  transcriptPath: string;
  workingDir?: string | null;
  sessionDir: string | null;
}): LiveTranscriptWatcher {
  let lastDigest: string | null = null;
  let lastTranscriptMtime = -1;
  let lastToolLogMtime = -1;

  return {
    poll(): TranscriptProjection | null {
      const transcriptMtime = fileMtimeMs(input.transcriptPath);
      const toolLogPath = input.sessionDir ? sessionToolLogFile(input.sessionDir) : null;
      const toolLogMtime = toolLogPath ? fileMtimeMs(toolLogPath) : -1;
      if (transcriptMtime === lastTranscriptMtime && toolLogMtime === lastToolLogMtime) return null;

      lastTranscriptMtime = transcriptMtime;
      lastToolLogMtime = toolLogMtime;
      const projection = readProjection();
      if (projection.digest === lastDigest) return null;
      lastDigest = projection.digest;
      return projection;
    },
    snapshot(): TranscriptProjection {
      return readProjection();
    },
  };

  function readProjection(): TranscriptProjection {
    return projectTranscriptLines({
      adapterName: input.adapterName,
      transcriptPath: input.transcriptPath,
      workingDir: input.workingDir,
      sessionDir: input.sessionDir,
      rawLines: readRawTranscriptLines(input.transcriptPath),
      toolLogEntries: input.sessionDir ? readToolLogEntries(input.sessionDir, 1000) : [],
    });
  }
}
