export class SnapshotRevisionConflictError extends Error {
  public readonly code = "SCENARIO_SNAPSHOT_REVISION_CONFLICT";

  public constructor(
    public readonly expectedRevision: number,
    public readonly currentRevision: number,
  ) {
    super(`Snapshot revision conflict: expected ${expectedRevision}, current ${currentRevision}`);
    this.name = "SnapshotRevisionConflictError";
  }
}

export class FeedbackTargetConflictError extends Error {
  public readonly code = "SCENARIO_FEEDBACK_TARGET_CONFLICT";

  public constructor(message: string) {
    super(message);
    this.name = "FeedbackTargetConflictError";
  }
}
