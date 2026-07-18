import { z } from "zod";
import { idSchema, sha256DigestSchema, timestampSchema } from "./common.js";

export const feedbackTargetKindValues = ["assistantMessage", "toolCall"] as const;
export const feedbackVoteValues = ["up", "down", "clear"] as const;

export const feedbackTargetSchema = z.object({
  kind: z.enum(feedbackTargetKindValues),
  id: idSchema,
  recordSeq: z.number().int().positive(),
  digest: sha256DigestSchema,
}).strict();
export type FeedbackTarget = z.infer<typeof feedbackTargetSchema>;

export const feedbackAuthorSchema = z.object({
  subjectId: z.string().min(1),
  clientId: z.string().min(1),
  clientVersion: z.string().min(1),
}).strict();
export type FeedbackAuthor = z.infer<typeof feedbackAuthorSchema>;

export const feedbackNoteSchema = z.string().superRefine((note, ctx) => {
  if ([...note.trim()].length <= 280) return;
  ctx.addIssue({
    code: "custom",
    message: "Feedback note must be at most 280 Unicode code points",
  });
});

export const feedbackSubmissionFields = {
  targetKind: z.enum(feedbackTargetKindValues),
  targetId: idSchema,
  vote: z.enum(feedbackVoteValues),
  note: feedbackNoteSchema.optional(),
  idempotencyKey: z.string().min(1),
  expectedTargetDigest: sha256DigestSchema.optional(),
  targetRecordSeq: z.number().int().positive().optional(),
} as const;

export type FeedbackStableTarget = {
  expectedTargetDigest?: string;
  targetRecordSeq?: number;
};

export function requireStableFeedbackTarget(
  payload: FeedbackStableTarget,
  ctx: z.RefinementCtx,
  path: PropertyKey[] = [],
): void {
  if (payload.expectedTargetDigest !== undefined || payload.targetRecordSeq !== undefined) return;
  ctx.addIssue({
    code: "custom",
    path,
    message: "feedback requires expectedTargetDigest or targetRecordSeq",
  });
}

export const feedbackEntrySchema = z.object({
  feedbackId: idSchema,
  runId: idSchema,
  target: feedbackTargetSchema,
  vote: z.enum(feedbackVoteValues),
  note: feedbackNoteSchema.optional(),
  createdAt: timestampSchema,
  author: feedbackAuthorSchema,
  supersedesFeedbackId: idSchema.nullable(),
  idempotencyKey: z.string().min(1),
}).strict();
export type FeedbackEntry = z.infer<typeof feedbackEntrySchema>;

export function validateFeedbackNote(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  const trimmed = feedbackNoteSchema.parse(note).trim();
  return trimmed || undefined;
}
