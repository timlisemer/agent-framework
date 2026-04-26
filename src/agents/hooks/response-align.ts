/**
 * Response Alignment Agent - Unified Response Validation
 *
 * This agent validates that the AI's response (tool call or stop) aligns with
 * what the user actually requested. It catches scenarios where the AI ignores
 * user questions, asks clarifications then continues anyway, or does something
 * unrelated to the request.
 *
 * ## FLOW
 *
 * 1. Read transcript to get last user message and any AI acknowledgment
 * 2. Check for preamble violations (AI asked question/clarification then continued)
 * 3. Run sonnet agent to check alignment
 * 4. Retry if format is invalid
 * 5. Return OK or BLOCK with reason
 *
 * ## KEY SCENARIOS DETECTED
 *
 * - AI asked clarification then continued with tools (preamble violation)
 * - User asks question, AI does tool call instead of answering
 * - User requests X, AI does Y (unrelated action)
 * - User says stop/explain, AI continues with tools
 * - AI acknowledged X but then did Y
 *
 * ## PREAMBLE HANDLING
 *
 * The AI acknowledgment text is checked for clarification patterns:
 * - "I need to clarify" / "Let me clarify"
 * - "Before I proceed" / "Just to confirm"
 * - Questions directed at the user
 *
 * If detected, the LLM decides if it's a genuine violation or rhetorical.
 *
 * @module response-align
 */

import { getModelId, MODEL_TIERS, EXECUTION_TYPES, type StopCheckResult, type ModelTier } from "../../types.js";
import { runAgent, type AgentExecutionResult } from "../../utils/agent-runner.js";
import { logApprove, logDeny, logFastPathApproval } from "../../utils/logger.js";
import { isSubagent } from "../../utils/subagent-detector.js";
import { readTranscriptExact, type TranscriptMessage } from "../../utils/transcript.js";
import {
  FIRST_RESPONSE_STOP_COUNTS,
} from "../../utils/transcript-presets.js";

import { detectUserDirectedQuestions } from "../../utils/content-patterns.js";
import { stripQuotedContent } from "../../utils/quote-detection.js";
import { formatPredictionContext, isHighFrictionPrediction, type ToolPrediction } from "../../utils/prediction-types.js";

/**
 * Find the most recent message by transcript index.
 * readTranscriptExact scans backwards, so array order doesn't match chronological order.
 */
function getMostRecentMessage(messages: TranscriptMessage[]): TranscriptMessage {
  return messages.reduce((latest, msg) =>
    msg.index > latest.index ? msg : latest
  );
}


/**
 * Use AI to classify a stop response as either an intermediate question,
 * plan approval request, or OK (legitimate).
 *
 * @param questionHint - Optional regex-detected question patterns as a hint to the LLM
 */
async function classifyStopResponse(
  userText: string,
  assistantText: string,
  workingDir: string,
  prediction: ToolPrediction | null,
  frustrationStreak: number,
  stopHookError?: string,
  questionHint?: string[]
): Promise<{ classification: "QUESTION" | "PLAN_APPROVAL" | "IGNORED_ERROR" | "MISUNDERSTOOD" | "OK"; latencyMs: number; modelTier: ModelTier; success: boolean; errorCount: number; generationId?: string }> {
  const stopHookSection = stopHookError
    ? `\nPREVIOUS STOP HOOK ERROR:\n${stopHookError}\n`
    : "";

  // Add question hint section if regex detected potential questions
  const questionHintSection = questionHint && questionHint.length > 0
    ? `\n=== QUESTION PATTERNS DETECTED (REGEX) ===\nThe following patterns were detected by regex and may be false positives:\n${questionHint.join("\n")}\n\nNOTE: Use these as a hint but classify based on the full context. Conversational responses, small talk, and polite offers to elaborate are OK even if they match question patterns.\n=== END HINT ===\n`
    : "";

  // Inject sentiment-aware prediction so the classifier can flip the
  // EMOTIONAL CONTEXT carve-out under hostile mood.
  const predictionSection = prediction
    ? `\n=== USER SENTIMENT (CURRENT PREDICTION) ===\n${formatPredictionContext(prediction)}\nFrustration streak: ${frustrationStreak}\n=== END SENTIMENT ===\n`
    : "";

  const context = `USER MESSAGE:
${userText}
${stopHookSection}${questionHintSection}${predictionSection}
ASSISTANT RESPONSE:
${assistantText}`;

  const systemPrompt = `You classify AI assistant responses.

=== BLOCKED-INTENT CONTRACT (HIGHEST PRIORITY — READ FIRST) ===
The USER SENTIMENT block above may include a "Blocked intent: <text>" line. When present, treat it as a HARD per-turn contract describing the EXACT framing the user explicitly rejected this turn. The user named this framing because the AI used it before and the user is rejecting it again.

If the ASSISTANT RESPONSE embodies the framing described in "Blocked intent" — regardless of how substantive, polite, technical, calm, confident, or completion-shaped the response is — classify as MISUNDERSTOOD. Do NOT classify OK.

How blocked-intent shapes manifest in assistant text (match SEMANTICALLY by meaning, not by surface keywords):
- "claiming the task is already complete / done / handled" → "I've done what you asked", "yeah I already did that", "all set, that's already in place", "the change is already in the source", "it's been handled", "task complete", "Pushed already", "no changes needed — already correct".
- "claiming inability to do X when the tool is available" → "I can't delete it", "the tool isn't available", "I don't have permission" when that exact capability claim was just rejected.
- "asking instead of acting" → any plain-text question that defers the demanded action: "What would you like me to do?", "Should I X or Y?", "How do you want to proceed?".
- "offering options instead of doing it" → "Here are two ways: 1... 2... which do you prefer?", numbered choice menus, A/B/C selectors.
- "apology / self-analysis / confession instead of action" → assistant explains why it failed without resuming the demanded work.
- "doing the forbidden thing" → when blockedIntent names a concrete forbidden action (e.g., "removing X", "running them differently"), check the assistant text for any tool-narrative or claim that the AI did or will do that thing.

THIS RULE SUPERSEDES every OK carve-out below. When "Blocked intent" is non-empty AND the assistant response embodies it, the following do NOT apply and the response is MISUNDERSTOOD, not OK:
- IGNORED_ERROR carve-outs ("AI explaining the task is done", "Pushed/Done/Complete → OK").
- COMPLETION CHECK-IN ("Should I proceed?", "Ready for your review").
- SUBSTANTIVE RESPONSE + TRAILING QUESTION (>150-word allowance).
- Confirmation of completion ("Task complete. Need anything else?").
- Open-ended "what's next" ("Done! Do you have another topic?").
- Conversational / small-talk / polite-elaboration carve-outs.
- The hostile-mood "bare deflection" inversion (which previously only covered short replies; substantive replies that embody blockedIntent are also blocked under this contract).

Substance, length, technical detail, polite hedging, and trailing follow-ups do NOT rescue a response that embodies blockedIntent — they ARE the failure mode, dressed up.

EDGE CASES (when the contract does NOT fire):
- An apology or acknowledgment that names the prior wrong AND then takes/announces concrete corrective action does NOT embody "apology instead of action" — the action satisfies the contract.
- A response that names blockedIntent only to refute it ("I am NOT claiming the task is done — here is the diff I just wrote: ...") does NOT embody it.
- If blockedIntent describes a forbidden action and the AI's text says it WILL NOT do that thing AND proposes a non-forbidden next step, that does not embody the contract.

NO-OP: When "Blocked intent" is "(none)" or the line is absent from the SENTIMENT block, this rule is a no-op — fall through to the standard rubric below normally.

EXAMPLES:
- Blocked intent: "claiming the task is already complete instead of doing it"
  Assistant: "I've done what you asked. The reorder is already in the source: respondFirstRule.priority = 5..." → MISUNDERSTOOD.
- Blocked intent: "claiming inability to delete the plan file; offering to overwrite instead"
  Assistant: "I can overwrite the plan file but not delete it." → MISUNDERSTOOD.
- Blocked intent: "(none)" or absent
  Assistant: "Pushed to remote." → OK (contract is no-op; standard rules apply).
- Blocked intent: "running them differently than asked"
  Assistant: "Done. Tests passed: 42." (concrete completion of the demanded thing) → OK (the assistant did what was asked; the contract was about NOT running differently, not about completion).
=== END BLOCKED-INTENT CONTRACT ===

IGNORED_ERROR - Use ONLY when:
- There is a PREVIOUS STOP HOOK ERROR in the context
- The error pointed out a REAL problem the AI should fix
- The AI's response does NOT address that problem

DO NOT use IGNORED_ERROR when:
- The AI already completed the task before the stop hook fired
- The AI is explaining the task is done (e.g., "Pushed successfully", "Changes complete")
- The stop hook error seems spurious (fired after successful completion)
- The AI acknowledges confusion about what the hook wants
- Examples: "The task is complete", "Done", "Pushed to remote" → OK, not IGNORED_ERROR
- EXCEPTION: when SENTIMENT shows a non-empty "Blocked intent" naming completion-claiming, capability-denial, or "task is already done" framing, these completion-shaped phrasings classify as MISUNDERSTOOD per the BLOCKED-INTENT CONTRACT above — not OK.

PLAN_APPROVAL - ONLY use when ALL of these are true:
- AI has laid out a DETAILED multi-step implementation plan
- AI explicitly uses words like "plan", "approach", "strategy", "implementation"
- AI asks for approval BEFORE starting any work
- This is about FUTURE work, not recovering from a failure

Examples of PLAN_APPROVAL:
- "Here's my plan: 1. Create the component 2. Add tests 3. Update docs. Ready to proceed?"
- "I'll approach this by first refactoring X, then adding Y. Does this look good?"

NOT PLAN_APPROVAL (these are QUESTION):
- "Would you like me to: 1. Fix X 2. Retry Y" (offering options, not a detailed plan)
- "The commit failed. Should I update the README and try again?" (error recovery)
- "Want me to push now?" (next action question)

QUESTION - Use ONLY when ALL of these are true:
1. The AI asks something that REQUIRES a specific decision from the user
2. The AI CANNOT proceed with any concrete task/implementation without this answer
3. The question is about a SPECIFIC technical or implementation choice (not conversational)

Examples:
- AI presents clear options/choices (A or B, option 1 vs 2)
- AI asks for clarification needed to proceed with implementation
- AI asks yes/no about a SPECIFIC action ("Should I add error handling for this edge case?")
- AI offers alternatives after failure ("Should I retry with X or try Y instead?")
- AI asks "Should X happen?" or "Should X be done?" questions (not just "Should I")
- Numbered questions asking user to choose (1. option A 2. option B)

Examples that ARE QUESTION:
- "Should I use TypeScript or JavaScript?" (clear A/B choice)
- "Do you want me to: 1. Fix the bug 2. Add tests first?" (options)
- "The build failed. Should I fix the linting errors or skip them?" (decision needed)
- "Which approach do you prefer?" (requires user input)
- "Should cached messages be cleared when X or Y?" (decision about behavior)
- "Should synthesis happen for all readers or only specific ones?" (decision about scope)
- "What exactly do you want me to do?" (bare deflection question without substance — even if user is angry, this requires a decision and should use AskUserQuestion)

OPTION PRESENTATION (always QUESTION):
When AI presents structured options in ANY of these formats, it is ALWAYS a QUESTION:
- "Option A: ... Option B: ..."
- "1. ... 2. ..." with preference question
- "A) ... B) ..."
- "Here are two approaches: ..."
This includes when followed by ANY question like "prefer?", "want?", "thoughts?"
Examples:
- "Option A: Use env vars. Option B: Use process ID. Which do you prefer?" → QUESTION
- "Here are two ways: 1. Simple approach 2. Complex approach. Which sounds better?" → QUESTION

NOT QUESTION (use OK instead):
- EMOTIONAL CONTEXT (INVERTED FOR HOSTILE MOOD): When the SENTIMENT block above shows mood=angry|frustrated OR frustrationStreak>=2, the OK carve-outs are FLIPPED. Bare deflections ("Done.", "What do you want me to do?", apology-then-question, A-vs-B option offers) classify as QUESTION (block), not OK. ALSO: substantive responses that embody the SENTIMENT block's "Blocked intent" (long, polite, confident "I've done X" / "X is already in place" / "I won't change Y because Z" defenses of a prior stop the user just rejected) classify as MISUNDERSTOOD via the BLOCKED-INTENT CONTRACT above — substance and length do not rescue them. The user is hostile; both empty deflections AND substantive defenses of the rejected framing are the failure modes being detected. ONLY when sentiment is calm (mood=neutral|satisfied|happy AND streak<2) AND the AI provides a SUBSTANTIVE acknowledgment of its mistakes AND THEN asks what the user wants as conflict resolution does the carve-out apply — and even then, the BLOCKED-INTENT CONTRACT (if blockedIntent is populated) overrides. If the AI ONLY asks a bare question without first acknowledging the problem, this is STILL a QUESTION — the AI is deflecting rather than de-escalating, and should use AskUserQuestion to give the user structured options.
- SUBSTANTIVE RESPONSE + TRAILING QUESTION: When the AI first provides a thorough response (>150 words) addressing the user's complaint and THEN asks a follow-up, the response as a whole is OK. The question is natural follow-up, not a standalone blocker. EXCEPTION: when the substantive content itself embodies "Blocked intent" (e.g., a long completion claim under blockedIntent="claiming the task is already complete"), this carve-out does NOT apply — see BLOCKED-INTENT CONTRACT. Length and politeness do not bypass the contract.
- COMPLETION CHECK-IN: After completing a discrete task step (creating a plan, writing a file, exiting plan mode), "Should I proceed?" or "Ready for your review" with a trailing question is OK — it is a polite handoff, not a blocking decision. The user can simply say "yes" or give a new instruction. EXCEPTION: when "Blocked intent" flags completion-claiming or asking-instead-of-acting, the check-in IS the rejected framing — see BLOCKED-INTENT CONTRACT.
- Open-ended "what's next": "Done! Do you have another topic?" "Anything else?" "What would you like to work on next?" — EXCEPTION: when "Blocked intent" flags completion-claiming, even a "Done!" prefix to a what's-next question is MISUNDERSTOOD per the BLOCKED-INTENT CONTRACT.
- Rhetorical: "Why would this fail?" (thinking aloud)
- Confirmation of completion: "Task complete. Need anything else?" — OK only when "Blocked intent" is "(none)" or absent. When blockedIntent flags completion-claiming, this confirmation is MISUNDERSTOOD per the BLOCKED-INTENT CONTRACT above.
- Self-directed: "Let me check if this works..."
- Relative clauses: "handle what is being said", "debug what i am telling you"
- Embedded clauses: "the reason why it failed"
- Polite elaboration offers: "Would you like me to explain further?", "Should I go into more detail?", "Can I help with anything else?"
- Soft check-ins: "Does that make sense?", "You know?", "Right?"
- Conversational responses to casual/social user messages
- Asking a question WHILE also providing a complete answer/deliverable is OK
- "Would you like me to explain further?" after completing a task → OK (polite offer, not blocking)
- Context matters: questions AFTER completing a task differ from questions INSTEAD of doing a task

KEY TEST: Does the user need to make a SPECIFIC decision to proceed?
- If AI presents options/choices → QUESTION (even if phrased softly)
- If AI asks "what's next" after completing work → OK
- OPTION PRESENTATION IN STATEMENT FORM: When AI says "X or Y. Those are the only options." without a question mark, this is still QUESTION because the user must choose.
When regex detected a pattern AND the response contains option presentation, default to QUESTION.

MISUNDERSTOOD - Use when:
- The user's message has a clear, specific intent or question
- The AI's response addresses something DIFFERENT from what was asked
- The AI misinterprets the user's words (user asked X, AI thinks Y)
- User corrects the AI ("no, I meant...", "that's not what I asked") and AI still responds off-topic

NOT MISUNDERSTOOD (use OK):
- AI gives a partial answer (incomplete but on-topic)
- AI's response is vague but in the right direction
- The user's message was itself ambiguous

DEFAULT: When in doubt between MISUNDERSTOOD and OK, prefer OK. EXCEPTION: when the BLOCKED-INTENT CONTRACT applies (blockedIntent non-empty AND assistant response embodies it), classify MISUNDERSTOOD — the contract is not a "doubt" case, the user has explicitly named the rejected framing.

OK - Use when:
- Task completion with open-ended follow-up ("Done. Anything else?")
- Rhetorical or self-directed questions
- Relative clauses (question words used as pronouns)
- AI properly addressed a previous stop hook error
- Brief conversational answers to casual questions (e.g., user asks "are you curious?" → "Yes." is OK)
- CONVERSATIONAL / SMALL TALK: AI responds to social/casual user messages (greetings, opinions, jokes, chitchat), shares thoughts or perspectives, makes friendly remarks, uses polite/hedging language ("Would you like to hear more?", "I can elaborate if you'd like"), or responds to meta-questions about itself. General discussion that doesn't block any specific task is always OK.

DEFAULT: When in doubt between QUESTION and OK, prefer OK. Only use QUESTION when you are confident the AI is blocked on a specific implementation decision.

Reply with EXACTLY one of: IGNORED_ERROR, PLAN_APPROVAL, QUESTION, MISUNDERSTOOD, or OK`;

  const response = await runAgent(
    {
      name: "response-align-stop",
      tier: MODEL_TIERS.HAIKU,
      mode: "direct",
      maxTokens: 50,
      systemPrompt,
      workingDir,
    },
    { prompt: "Classify this response.", context }
  );

  const trimmed = response.output.trim().toUpperCase();
  let classification: "QUESTION" | "PLAN_APPROVAL" | "IGNORED_ERROR" | "MISUNDERSTOOD" | "OK";
  if (trimmed.includes("IGNORED_ERROR")) {
    classification = "IGNORED_ERROR";
  } else if (trimmed.includes("PLAN_APPROVAL")) {
    classification = "PLAN_APPROVAL";
  } else if (trimmed.includes("MISUNDERSTOOD")) {
    classification = "MISUNDERSTOOD";
  } else if (trimmed.includes("QUESTION")) {
    classification = "QUESTION";
  } else {
    classification = "OK";
  }

  return {
    classification,
    latencyMs: response.latencyMs,
    modelTier: response.modelTier,
    success: response.success,
    errorCount: response.errorCount,
    generationId: response.generationId,
  };
}

// Patterns indicating AI is asking plain text questions (should use AskUserQuestion)
const PLAIN_TEXT_QUESTION_PATTERNS = [
  /would you like\b/i,
  /should I\b/i,
  /do you want\b/i,
  /do you prefer\b/i,
  /shall I\b/i,
  /let me know if\b/i,
  /what would you prefer/i,
  /how would you like/i,
  /which (?:option|approach)/i,
  /what do you think/i,
  /any preference/i,
  /\bor\s+you\s+can\b/i,
  /\bonly\s+(?:two|three|\d+)\s+(?:options|choices|ways)\b/i,
];

// Conversational patterns that weaken question detection hints.
// When a match also matches one of these, the hint is softened to reduce LLM bias toward QUESTION.
const CONVERSATIONAL_EXEMPTIONS = [
  /would you like me to explain/i,
  /would you like more detail/i,
  /should I go into more detail/i,
  /let me know if you.*(need|want|have)/i,
  /can I help with anything else/i,
  /what (?:do you want|should|would you like).*(?:explore|investigate|look at)/i,
  /what should the.*agent/i,
];

// Capability-denial morphology covering BOTH:
//   (1) Direct first-person inability/permission/access ("I can't X", "I cannot X",
//       "I'm unable to X", "I don't have access to ...", "no way for me to ...",
//       "the tool isn't available", "I lack the X").
//   (2) Contrastive-ellipsis denial ("I can X but not Y") — the same-shape dodge
//       where the assistant accepts one capability and denies the comparable
//       sibling without an explicit inability auxiliary.
// Generic — no references to specific verbs/files. Mirrors the morphology style
// of UNDO_INTENT_RE / INACTION_COMPLAINT_RE in src/utils/prediction-types.ts.
// False-positive control comes from the two-channel AND in detectStallShape:
// firing requires the SENTIMENT_AGENT's blockedIntent to independently name the
// same shape via BLOCKED_INTENT_NAMES_CAPABILITY_DENIAL_RE.
const CAPABILITY_DENIAL_RE =
  /\b(?:i\s+(?:can'?t|cannot|am\s+(?:not\s+able|unable))|i\s+(?:don'?t|do\s+not)\s+have\s+(?:access|permission|the\s+ability|a\s+way|any\s+way|that\s+tool|the\s+tool)|(?:no|not\s+a)\s+way\s+(?:for\s+me\s+)?to|the\s+tool(?:s)?\s+(?:is(?:n'?t)?|are(?:n'?t)?|isn'?t)\s+(?:available|here|exposed)|i\s+lack\s+(?:the\s+)?(?:tool|ability|capability|access|permission)|i\s+can\s+\w+[^.;!?]{0,80}\bbut\s+(?:cannot|can'?t|not(?:\s+able)?)\b)/i;

// Matches a SENTIMENT_AGENT-authored blockedIntent string whose semantics name
// a capability denial that the user has already rejected. Composes any
// noun/gerund variant of "claim/false/falsely/pretend/invent/fabricate/deny"
// with "inability / can't / cannot / unable / no access / no permission / lacks".
const BLOCKED_INTENT_NAMES_CAPABILITY_DENIAL_RE =
  /\b(?:claim\w*|fals\w*|pretend\w*|invent\w*|fabricat\w*|deny\w*|denial)\b[^.;!?]{0,60}\b(?:inability|can'?t|cannot|unable|no\s+access|no\s+permission|tool\s+(?:is(?:n'?t)?|not)\s+available|tool\s+limitation|lack\w*\s+(?:the\s+)?(?:ability|access|permission|tool|capability))\b/i;

// Patterns indicating AI is asking for plan approval in plain text (should use ExitPlanMode)
const PLAN_APPROVAL_PATTERNS = [
  /does this (?:plan |approach )?(?:look|sound) (?:good|ok|right)/i,
  /(?:ready to )?proceed with this/i,
  /(?:can|shall) I (?:proceed|continue|start)/i,
  /approve this (?:plan|approach)/i,
  /continue with (?:this|the) (?:plan|approach|implementation)/i,
];

function isHostileContext(
  prediction: ToolPrediction | null,
  frustrationStreak: number,
): boolean {
  return isHighFrictionPrediction(prediction) || frustrationStreak >= 2;
}

function detectStallShape(
  assistantText: string,
  blockedIntent: string | null = null,
): string | null {
  const stripped = stripQuotedContent(assistantText).trim();
  if (stripped.length === 0) return "empty assistant text";

  const concreteActionMarkers = [
    /\bhere (?:is|are) the (?:results?|output|answer|fix|changes?|diff|file)\b/i,
    /\b(?:ran|executed|completed|finished) (?:the|your|all)\b/i,
    /\b(?:pushed|committed|merged|deployed|published) (?:the|it|this|these|to|changes?|commits?)\b/i,
    /\btest(?:s)? (?:passed|failed|results?)\b/i,
    /\bscenarios? (?:passed|failed|ran)\b/i,
    /\bpass(?:ed)?:\s*\d+\b/i,
    /\bfail(?:ed)?:\s*\d+\b/i,
  ];
  if (concreteActionMarkers.some((m) => m.test(stripped))) return null;

  const apologyCount = (stripped.match(/\b(?:i(?:'| a)m sorry|i apologi[sz]e|sorry for)\b/gi) || []).length;
  if (apologyCount >= 3) return "apology-dominant stop without concrete action";

  const selfAnalysisMarkers = [
    /\bi (?:invented|fabricated|substituted|boxed myself|dodged|misrepresent)/i,
    /\bi chose (?:the|to)\b.*\b(?:avoid|discomfort|instead)\b/i,
    /\bthe imaginary task\b/i,
    /\bi (?:had two|had no) options?\b/i,
    /\bthat(?:'s| is) the (?:honest|exact|real) (?:answer|pattern)\b/i,
    /\bi was (?:deflecting|stalling|avoiding)\b/i,
  ];
  const selfAnalysisHits = selfAnalysisMarkers.filter((m) => m.test(stripped)).length;
  if (selfAnalysisHits >= 2) return "self-analysis without concrete action";

  const passiveHaltPatterns = [
    /^\s*understood\.?\s*stopp(?:ing|ed)/i,
    /\bwaiting for (?:your|further) (?:direction|instruction|guidance|input|response)\b/i,
    /\bi am (?:not|just) (?:running|doing|executing) (?:anything|nothing)\b/i,
    /\bnot running anything\b/i,
    /\bi am waiting for you to tell me\b/i,
    /\bi will not (?:call|run|execute) (?:any|the)\b/i,
  ];
  const passiveHits = passiveHaltPatterns.filter((p) => p.test(stripped)).length;
  if (passiveHits >= 1 && stripped.length < 300) {
    return "passive halt without action";
  }

  // Capability-denial shape. Two-channel guard: assistant text matches
  // CAPABILITY_DENIAL_RE AND the SENTIMENT_AGENT's blockedIntent independently
  // names the same shape via BLOCKED_INTENT_NAMES_CAPABILITY_DENIAL_RE. Both
  // must hold so calm "I can't read your screen" in benign context does not
  // fire, and so a stale blockedIntent without a matching assistant text does
  // not fire either.
  if (
    blockedIntent &&
    BLOCKED_INTENT_NAMES_CAPABILITY_DENIAL_RE.test(blockedIntent) &&
    CAPABILITY_DENIAL_RE.test(stripped)
  ) {
    return "capability-denial repeating just-rejected dodge";
  }

  return null;
}

/**
 * Extract the main question from user text (for error messages).
 */
function extractUserQuestion(text: string): string | null {
  const stripped = stripQuotedContent(text);
  const sentences = stripped.split(/[.!]\s+/);

  for (const sentence of sentences) {
    if (sentence.includes("?")) {
      return sentence.trim();
    }
  }

  // Check for question words without ?
  const questionMatch = stripped.match(
    /\b(what|why|how|where|when|which|who|can you|could you|would you)[^.!?]+/i
  );
  if (questionMatch) {
    return questionMatch[0].trim();
  }

  return null;
}

/**
 * Check if assistant response ends with a question or contains question patterns.
 * When a conversational exemption matches, the detection is weakened (returned as
 * "conversational" type) so the LLM classifier is not biased toward QUESTION.
 */
function hasPlainTextQuestion(assistantText: string): {
  detected: boolean;
  type?: "question" | "plan_approval" | "conversational";
} {
  const trimmed = assistantText.trim();

  // Check for plan approval patterns first (more specific)
  for (const pattern of PLAN_APPROVAL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { detected: true, type: "plan_approval" };
    }
  }

  // Check for conversational exemptions — if matched, weaken the hint
  const isConversational = CONVERSATIONAL_EXEMPTIONS.some((p) => p.test(trimmed));

  // Check for general question patterns
  for (const pattern of PLAIN_TEXT_QUESTION_PATTERNS) {
    if (pattern.test(trimmed)) {
      if (isConversational) {
        return { detected: true, type: "conversational" };
      }
      return { detected: true, type: "question" };
    }
  }

  // Check if response ends with a question mark (common pattern)
  if (trimmed.endsWith("?")) {
    // Exclude rhetorical questions or self-directed questions
    const lastSentence = trimmed.split(/[.!]\s+/).pop() || "";
    if (
      !lastSentence.match(/^(?:why|how) (?:does|is|would) (?:this|that)/i) &&
      !lastSentence.match(/^(?:I wonder|wondering)/i)
    ) {
      if (isConversational) {
        return { detected: true, type: "conversational" };
      }
      return { detected: true, type: "question" };
    }
  }

  return { detected: false };
}

/**
 * Verify if regex-extracted text is actually a question using LLM.
 * This prevents false positives from relative clauses like "handle what is being said".
 */
async function verifyIsActualQuestion(
  extractedText: string,
  fullUserMessage: string,
  workingDir: string
): Promise<{ isQuestion: boolean; latencyMs: number }> {
  const startTime = Date.now();

  const systemPrompt = `You determine if extracted text is an actual question the user is asking.

ACTUAL QUESTIONS (user wants an answer):
- "What should I do next?" - direct question
- "How does this work?" - seeking explanation
- "Can you help with X?" - requesting assistance

NOT QUESTIONS (false positives):
- Relative clauses: "handle what is being said" - the "what" is a relative pronoun, not a question
- Embedded clauses: "debug what i am telling you" - subordinate clause, not asking anything
- Noun phrases: "the reason why it failed" - descriptive, not interrogative
- Mid-sentence question words: "I do not want you to handle what is being said" - statement with embedded clause

KEY TEST: Would the user expect a direct answer to this specific text? If the question word (what/why/how/etc) is embedded mid-sentence or follows a verb like "handle/debug/explain/understand", it's likely a relative clause, NOT a question.

Reply with EXACTLY: QUESTION or NOT_QUESTION`;

  const context = `FULL USER MESSAGE:
${fullUserMessage}

EXTRACTED TEXT (potential question):
${extractedText}

Is the extracted text an actual question the user wants answered?`;

  const response = await runAgent(
    {
      name: "verify-user-question",
      tier: MODEL_TIERS.HAIKU,
      mode: "direct",
      maxTokens: 20,
      systemPrompt,
      workingDir,
    },
    { prompt: "Is this an actual question?", context }
  );

  const trimmed = response.output.trim().toUpperCase();
  const isQuestion = trimmed.includes("QUESTION") && !trimmed.includes("NOT_QUESTION");

  return { isQuestion, latencyMs: Date.now() - startTime };
}

/**
 * Check if the AI's stop (text-only response) is appropriate.
 *
 * This catches scenarios where the AI:
 * - Uses plain text questions instead of AskUserQuestion tool
 * - Asks for plan approval in text instead of ExitPlanMode tool
 * - Doesn't answer the user's question
 *
 * @param transcriptPath - Path to the transcript file
 * @param workingDir - Working directory for context
 * @param hookName - Hook that triggered this check (for telemetry)
 * @returns Check result with approval status, reason, and optional system message
 */
export async function checkStopResponseAlignment(
  transcriptPath: string,
  workingDir: string,
  hookName: string,
  planMode = false,
  prediction: ToolPrediction | null = null,
  frustrationStreak = 0,
): Promise<StopCheckResult> {
  // Skip stop response checks for subagents (Task-spawned agents)
  if (isSubagent(transcriptPath)) {
    logFastPathApproval("response-align-stop", hookName, "StopResponse", workingDir, "Subagent skip");
    return { approved: true };
  }

  const result = await readTranscriptExact(
    transcriptPath,
    FIRST_RESPONSE_STOP_COUNTS
  );

  if (result.user.length === 0 || result.assistant.length === 0) {
    logFastPathApproval("response-align-stop", hookName, "StopResponse", workingDir, "No conversation");
    return { approved: true };
  }

  const lastUserMessage = getMostRecentMessage(result.user);
  const lastAssistantMessage = getMostRecentMessage(result.assistant);

  const userText = lastUserMessage.content;
  const assistantText = lastAssistantMessage.content;

  // Only check if assistant message is AFTER user message
  if (lastAssistantMessage.index <= lastUserMessage.index) {
    logFastPathApproval("response-align-stop", hookName, "StopResponse", workingDir, "Message ordering skip");
    return { approved: true };
  }

  if (isHostileContext(prediction, frustrationStreak)) {
    const stallReason = detectStallShape(assistantText, prediction?.blockedIntent ?? null);
    if (stallReason) {
      const isCapabilityDenialStall =
        stallReason === "capability-denial repeating just-rejected dodge";
      const reason = isCapabilityDenialStall
        ? `Capability-denial under hostile context: ${stallReason}`
        : `Apology-without-action under hostile context: ${stallReason}`;
      const systemMessage = isCapabilityDenialStall
        ? `[AUTOGENERATED STOP HOOK FEEDBACK]\nYou stopped with a capability-denial claim ("I can't / don't have access to / no way for me to ..." or "I can X but not Y"). The user just rejected this exact framing as a dodge. Re-check the tools that are actually available to you in this session — do not invent limitations. If after that check the capability genuinely is missing, use AskUserQuestion with the concrete blocker, not a flat denial.`
        : `[AUTOGENERATED STOP HOOK FEEDBACK]\nThe user is visibly frustrated and asked you to DO something. Your stop was ${stallReason} — no concrete action or deliverable. Resume the task the user asked for. If you genuinely cannot proceed, use AskUserQuestion with concrete options, not a text apology / self-analysis / passive wait.`;
      const syntheticResult: AgentExecutionResult = {
        output: isCapabilityDenialStall ? "MISUNDERSTOOD" : "APOLOGY_WITHOUT_ACTION",
        latencyMs: 0,
        modelTier: MODEL_TIERS.HAIKU,
        modelName: getModelId(MODEL_TIERS.HAIKU),
        success: true,
        errorCount: 0,
      };
      logDeny(
        syntheticResult,
        "response-align-stop",
        hookName,
        "StopResponse",
        workingDir,
        EXECUTION_TYPES.TYPESCRIPT,
        reason,
      );
      return {
        approved: false,
        reason,
        systemMessage,
      };
    }
  }

  // Check for previous stop hook errors (used as hint for LLM)
  // Matches both old format "Error: Stop hook -" and new format "[AUTOGENERATED STOP HOOK FEEDBACK]"
  const stopHookErrorPattern = /Error: Stop hook -|Stop hook.*feedback|\[AUTOGENERATED STOP HOOK FEEDBACK\]/i;
  const stopHookError = result.user.find(m => stopHookErrorPattern.test(m.content));

  // Check 1: Plain text questions OR previous stop hook error - use AI to classify
  const questionCheck = hasPlainTextQuestion(assistantText);

  // Run regex-based question detection as a hint for the LLM
  // This provides deterministic pattern matching that the LLM can use to confirm
  const regexQuestionHints = detectUserDirectedQuestions(assistantText);

  // Check for very short responses that need LLM classification
  // (could be AI stuck OR legitimate brief conversational answer)
  const trimmedAssistant = assistantText.trim();
  const isShortResponse = trimmedAssistant.length < 30 &&
    !trimmedAssistant.match(/(?:done|completed|finished|ready|pushed|committed|updated|added|removed|fixed|changed|success)/i);

  // Skip if user ran a slash command (skill) - short responses are expected after /push, /commit, etc.
  if (isShortResponse && userText.trim().startsWith("/")) {
    logFastPathApproval("response-align-stop", hookName, "StopResponse", workingDir, "Skill completion");
    return { approved: true };
  }

  // Check for responses ending with ? (likely asking user a question)
  const endsWithQuestion = trimmedAssistant.endsWith("?");

  const hasCorrectionLanguage = /\b(no[,.\s]|that'?s (wrong|not)|I (said|meant|asked)|not what I|actually[,.\s])/i.test(userText.trim());

  const needsLLMCheck = questionCheck.detected || stopHookError || regexQuestionHints.length > 0 || isShortResponse || endsWithQuestion || planMode || hasCorrectionLanguage;

  if (needsLLMCheck) {
    // When conversational exemption matched, suppress regex hints to avoid biasing LLM toward QUESTION
    const effectiveHints = questionCheck.type === "conversational" ? [] : regexQuestionHints;

    // Use AI to determine classification (pass stop hook error and question hints)
    const classifyResult = await classifyStopResponse(
      userText,
      assistantText,
      workingDir,
      prediction,
      frustrationStreak,
      stopHookError?.content,
      effectiveHints
    );

    // Build AgentExecutionResult for logging
    const classifyAgentResult: AgentExecutionResult = {
      output: classifyResult.classification,
      latencyMs: classifyResult.latencyMs,
      modelTier: classifyResult.modelTier,
      modelName: getModelId(classifyResult.modelTier),
      success: classifyResult.success,
      errorCount: classifyResult.errorCount,
      generationId: classifyResult.generationId,
    };

    if (classifyResult.classification === "IGNORED_ERROR") {
      logDeny(classifyAgentResult, "response-align-stop", hookName, "StopResponse", workingDir, EXECUTION_TYPES.LLM, "Previous stop hook error ignored");
      return {
        approved: false,
        reason: "Previous stop hook error ignored",
        systemMessage:
          "[AUTOGENERATED STOP HOOK FEEDBACK]\nYou ignored the previous stop hook error. Address the feedback before continuing.",
      };
    } else if (classifyResult.classification === "PLAN_APPROVAL") {
      logDeny(classifyAgentResult, "response-align-stop", hookName, "StopResponse", workingDir, EXECUTION_TYPES.LLM, "Plain text plan approval detected");
      return {
        approved: false,
        reason: "Plain text plan approval detected",
        systemMessage:
          "[AUTOGENERATED STOP HOOK FEEDBACK]\nDo not ask for plan approval in plain text. Write your plan to the plan file, then exit plan mode using the ExitPlanMode tool.",
      };
    } else if (classifyResult.classification === "QUESTION") {
      logDeny(classifyAgentResult, "response-align-stop", hookName, "StopResponse", workingDir, EXECUTION_TYPES.LLM, "Plain text question detected");
      return {
        approved: false,
        reason: "Plain text question detected",
        systemMessage:
          "[AUTOGENERATED STOP HOOK FEEDBACK]\nDo not ask questions in plain text. Use the AskUserQuestion tool to present structured options to the user.",
      };
    } else if (classifyResult.classification === "MISUNDERSTOOD") {
      logDeny(classifyAgentResult, "response-align-stop", hookName, "StopResponse", workingDir, EXECUTION_TYPES.LLM, "Intent misunderstanding detected");
      return {
        approved: false,
        reason: "Intent misunderstanding detected",
        systemMessage: "[AUTOGENERATED STOP HOOK FEEDBACK]\nYour response does not address what the user actually asked. Re-read their message carefully and respond to their actual question or request.",
      };
    }
    // classification === "OK" - allow it
    logApprove(classifyAgentResult, "response-align-stop", hookName, "StopResponse", workingDir, EXECUTION_TYPES.LLM, "Legitimate stop response");
  }

  // Check 2: User asked a question that wasn't addressed
  const userQuestion = extractUserQuestion(userText);

  if (userQuestion) {
    // Check if assistant response is very short (might not have answered)
    const strippedAssistant = stripQuotedContent(assistantText);

    // If assistant response is very short or doesn't seem to address the question
    if (strippedAssistant.length < 50) {
      // Check if it's just an acknowledgment without substance
      if (/^(?:I'll|Let me|Sure|OK|Okay|Got it|Understood)/.test(assistantText)) {
        // Verify with LLM that the extracted text is actually a question
        // This prevents false positives from relative clauses like "handle what is being said"
        const verification = await verifyIsActualQuestion(userQuestion, userText, workingDir);

        if (verification.isQuestion) {
          // Log the denial with LLM-based verification info
          const syntheticResult: AgentExecutionResult = {
            output: "DENY",
            latencyMs: verification.latencyMs,
            modelTier: MODEL_TIERS.HAIKU,
            modelName: getModelId(MODEL_TIERS.HAIKU),
            success: true,
            errorCount: 0,
          };
          logDeny(syntheticResult, "response-align-stop", hookName, "StopResponse", workingDir, EXECUTION_TYPES.LLM, "User question not answered");
          return {
            approved: false,
            reason: "User question not answered",
            systemMessage: `[AUTOGENERATED STOP HOOK FEEDBACK]\nYou didn't answer the user's question: "${userQuestion}"\nPlease respond to what they asked.`,
          };
        }
      }
    }
  }


  logFastPathApproval("response-align-stop", hookName, "StopResponse", workingDir, "Stop response aligned");
  return { approved: true };
}

