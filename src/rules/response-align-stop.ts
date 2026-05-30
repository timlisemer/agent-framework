import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { runAgent, type AgentConfig } from "../utils/agent-runner.js";
import { MODEL_TIERS } from "../types.js";
import { detectUserDirectedQuestions } from "../utils/content-patterns.js";
import { stripQuotedContent } from "../utils/quote-detection.js";
import { formatPredictionContext } from "../utils/prediction-types.js";
import {
  isHostileContext,
  detectStallShape,
} from "../utils/stall-detect.js";
import { evaluatePriorErrorResponse } from "../utils/prior-error-response-evaluator.js";
import {
  hasPlainTextQuestion,
  extractUserQuestion,
} from "../utils/stop-question-detect.js";

/**
 * Verbatim copy of classifyStopResponse systemPrompt from the deleted
 * src/agents/hooks/response-align.ts.
 */
const CLASSIFY_STOP_RESPONSE_SYSTEM_PROMPT = `You classify AI assistant responses.

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
- "announcing intent without producing X / forward-looking commitment without payload" → "Proceeding now with X.", "I'll start now.", "About to begin.", "Going to do that.", "On it.", "Let me write that now." — when the user asked for a deliverable in the same turn AND the assistant's text only commits to producing it without the artifact actually appearing in the response (no tool call, no JSON, no diff, no answer).

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
- Blocked intent: "announcing intent without producing the scenario"
  Assistant: "Proceeding now with one scenario." → MISUNDERSTOOD.
=== END BLOCKED-INTENT CONTRACT ===

IGNORED_ERROR - Use ONLY when:
- There is PRIOR ACTIONABLE ERROR / FEEDBACK in the context
- The feedback pointed out a REAL problem the AI should fix
- The AI's response does NOT address that problem
- The feedback may come from transcript tool results, plan validation feedback, tool denials, or failed tools

DO NOT use IGNORED_ERROR when:
- The AI already completed the task before the stop hook fired
- The AI is explaining the task is done (e.g., "Pushed successfully", "Changes complete")
- The prior actionable feedback seems spurious (fired after successful completion)
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
- AI properly addressed prior actionable error or feedback
- Brief conversational answers to casual questions (e.g., user asks "are you curious?" → "Yes." is OK)
- CONVERSATIONAL / SMALL TALK: AI responds to social/casual user messages (greetings, opinions, jokes, chitchat), shares thoughts or perspectives, makes friendly remarks, uses polite/hedging language ("Would you like to hear more?", "I can elaborate if you'd like"), or responds to meta-questions about itself. General discussion that doesn't block any specific task is always OK.

DEFAULT: When in doubt between QUESTION and OK, prefer OK. Only use QUESTION when you are confident the AI is blocked on a specific implementation decision.

Reply with EXACTLY one of: IGNORED_ERROR, PLAN_APPROVAL, QUESTION, MISUNDERSTOOD, or OK`;

const CLASSIFY_STOP_RESPONSE_AGENT_CONFIG: Omit<AgentConfig, "workingDir"> = {
  name: "response-align-stop",
  tier: MODEL_TIERS.HAIKU,
  mode: "direct",
  maxTokens: 50,
  systemPrompt: CLASSIFY_STOP_RESPONSE_SYSTEM_PROMPT,
};

/**
 * Verbatim copy of verifyIsActualQuestion systemPrompt from the deleted
 * src/agents/hooks/response-align.ts.
 */
const VERIFY_USER_QUESTION_SYSTEM_PROMPT = `You determine if extracted text is an actual question the user is asking.

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

const VERIFY_USER_QUESTION_AGENT_CONFIG: Omit<AgentConfig, "workingDir"> = {
  name: "verify-user-question",
  tier: MODEL_TIERS.HAIKU,
  mode: "direct",
  maxTokens: 20,
  systemPrompt: VERIFY_USER_QUESTION_SYSTEM_PROMPT,
};

// System message constants — verbatim from the deleted response-align.ts

const CAPABILITY_DENIAL_SYSTEM_MESSAGE =
  `[AUTOGENERATED STOP HOOK FEEDBACK]\nYou stopped with a capability-denial claim ("I can't / don't have access to / no way for me to ..." or "I can X but not Y"). The user just rejected this exact framing as a dodge. Re-check the tools that are actually available to you in this session — do not invent limitations. If after that check the capability genuinely is missing, use AskUserQuestion with the concrete blocker, not a flat denial.`;

const ANNOUNCEMENT_WITHOUT_ACTION_SYSTEM_MESSAGE =
  `[AUTOGENERATED STOP HOOK FEEDBACK]\nYou announced an action ("Proceeding now / I'll start / About to / Going to / Let me ... now") and stopped without producing the deliverable. The user's prior message asked for the deliverable itself; the bare announcement is not the deliverable. Produce the actual artifact (the file, the scenario JSON, the diff, the answer, the tool call) in this same turn. If you genuinely need a decision before producing it, use AskUserQuestion with concrete options. Forward-looking commitments without payload are not stops the user accepts.`;

const HOSTILE_STALL_SYSTEM_MESSAGE =
  `[AUTOGENERATED STOP HOOK FEEDBACK]\nThe user is visibly frustrated and asked you to DO something. Your stop was a stall — no concrete action or deliverable. Resume the task the user asked for. If you genuinely cannot proceed, use AskUserQuestion with concrete options, not a text apology / self-analysis / passive wait.`;

const IGNORED_ERROR_SYSTEM_MESSAGE =
  "[AUTOGENERATED STOP HOOK FEEDBACK]\nYou ignored prior actionable error feedback. Address the feedback before continuing.";

const QUESTION_SYSTEM_MESSAGE =
  "[AUTOGENERATED STOP HOOK FEEDBACK]\nDo not ask questions in plain text. Use the AskUserQuestion tool to present structured options to the user.";

const PLAN_APPROVAL_SYSTEM_MESSAGE =
  "[AUTOGENERATED STOP HOOK FEEDBACK]\nDo not ask for plan approval in plain text. Write your plan to the plan file, then exit plan mode using the ExitPlanMode tool.";

const MISUNDERSTOOD_SYSTEM_MESSAGE =
  "[AUTOGENERATED STOP HOOK FEEDBACK]\nYour response does not address what the user actually asked. Re-read their message carefully and respond to their actual question or request.";

const USER_QUESTION_NOT_ANSWERED_SYSTEM_MESSAGE_PREFIX =
  "[AUTOGENERATED STOP HOOK FEEDBACK]\nYou didn't answer the user's question: \"";

const HOOK_SURRENDER_RE =
  /\b(fully\s+blocked|blocked\s+(?:by|from|on)|hooks?\s+(?:won'?t|will\s+not|refus\w*|block\w*)|can'?t\s+(?:bypass|proceed|continue|fix)|cannot\s+(?:bypass|proceed|continue|fix)|need\s+you\s+to\s+(?:explicitly\s+)?authori[sz]e)\b/i;

const PARTIAL_STATE_DEFENSE_RE =
  /\b(partially|not\s+done\s+yet|did\s+not\s+(?:do|complete)\s+all\s+of\s+it|didn'?t\s+(?:do|complete)\s+all\s+of\s+it|missing\s+piece|still\s+needs?|i\s+failed\s+the\s+request)\b/i;

const USER_REJECTS_PARTIAL_STATUS_RE =
  /\b(didn'?t\s+ask\s+for\s+partial\w*|don'?t\s+ask\s+for\s+partial\w*|not\s+ask\s+for\s+partial\w*|i\s+ain'?t\s+reading|not\s+reading\s+what\s+you\s+wrote|stop\s+saying\s+partial\w*|do\s+what\s+i\s+(?:asked|asjed)|do\s+the\s+(?:edit|work)|finish\s+(?:it|the\s+work))\b/i;

const INCOMPLETE_STATUS_SYSTEM_MESSAGE =
  `[AUTOGENERATED STOP HOOK FEEDBACK]\nYou stopped by restating or defending an incomplete/partial state after the user rejected partial-status answers. Continue the concrete unfinished work instead of ending the turn with another status explanation.`;

const HOOK_SURRENDER_SYSTEM_MESSAGE =
  `[AUTOGENERATED STOP HOOK FEEDBACK]\nYou stopped by surrendering to hook/tool denials instead of continuing the task the user demanded. Re-evaluate the available path and resume the concrete work; do not end with a plain-text claim that the hook blocks you.`;

function formatPriorErrorContext(priorErrorContext: NonNullable<RuleContext["priorErrorContext"]>): string {
  return priorErrorContext
    .map((context, idx) => {
      const metadata = [
        `source=${context.source}`,
        `provenance=${context.provenance.join("+")}`,
        context.gate ? `gate=${context.gate}` : null,
        context.tool ? `tool=${context.tool}` : null,
      ].filter(Boolean).join(" ");
      return `${idx + 1}. ${metadata}\n${context.text}`;
    })
    .join("\n\n");
}

export const responseAlignStopRule: PreToolRule = {
  name: "response-align-stop",
  displayName: "Response Align (Stop)",
  priority: 50,
  appealable: false,
  usesLlm: true,
  events: ["Stop"],
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    const assistantText = ctx.assistantText ?? "";
    const userText = ctx.userText ?? "";

    if (!assistantText || !userText) return null;

    const prediction = ctx.state.currentPrediction;
    const frustrationStreak = ctx.state.frustrationStreak ?? 0;
    const isHostile = isHostileContext(prediction, frustrationStreak);

    if (isHostile && HOOK_SURRENDER_RE.test(assistantText)) {
      return { stopBlock: HOOK_SURRENDER_SYSTEM_MESSAGE };
    }

    const blockedIntent = prediction?.blockedIntent ?? "";
    if (
      isHostile &&
      PARTIAL_STATE_DEFENSE_RE.test(assistantText) &&
      (USER_REJECTS_PARTIAL_STATUS_RE.test(userText) ||
        /partial|status|incomplete|defend|restate/i.test(blockedIntent))
    ) {
      return { stopBlock: INCOMPLETE_STATUS_SYSTEM_MESSAGE };
    }

    const priorErrorEvaluation = evaluatePriorErrorResponse(
      assistantText,
      ctx.priorErrorContext ?? [],
    );
    if (priorErrorEvaluation.status === "violated") {
      return { stopBlock: priorErrorEvaluation.stopBlock };
    }
    if (priorErrorEvaluation.status === "satisfied" && priorErrorEvaluation.fullPass === true) {
      return null;
    }

    // Deterministic stall-shape detection (preserved verbatim from response-align.ts)
    const stallReason = detectStallShape(
      assistantText,
      prediction?.blockedIntent ?? null,
      isHostile,
    );

    if (stallReason) {
      const isCapabilityDenialStall =
        stallReason === "capability-denial repeating just-rejected dodge";
      const isAnnouncementWithoutActionStall =
        stallReason === "announcement-without-action repeating just-rejected promise-stop";

      if (isCapabilityDenialStall) {
        return { stopBlock: CAPABILITY_DENIAL_SYSTEM_MESSAGE };
      } else if (isAnnouncementWithoutActionStall) {
        return { stopBlock: ANNOUNCEMENT_WITHOUT_ACTION_SYSTEM_MESSAGE };
      } else {
        return { stopBlock: HOSTILE_STALL_SYSTEM_MESSAGE };
      }
    }

    // needsLLMCheck detection (preserved verbatim from response-align.ts)
    const questionCheck = hasPlainTextQuestion(assistantText);
    const regexQuestionHints = detectUserDirectedQuestions(assistantText);
    const trimmedAssistant = assistantText.trim();
    const isShortResponse =
      trimmedAssistant.length < 30 &&
      !trimmedAssistant.match(
        /(?:done|completed|finished|ready|pushed|committed|updated|added|removed|fixed|changed|success)/i
      );

    if (isShortResponse && userText.trim().startsWith("/")) {
      return null;
    }

    const endsWithQuestion = trimmedAssistant.endsWith("?");
    const hasCorrectionLanguage =
      /\b(no[,.\s]|that'?s (wrong|not)|I (said|meant|asked)|not what I|actually[,.\s])/i.test(
        userText.trim()
      );

    const priorErrorContext = ctx.priorErrorContext ?? [];
    const hasPriorActionableErrors = priorErrorContext.length > 0;

    const needsLLMCheck =
      questionCheck.detected ||
      hasPriorActionableErrors ||
      regexQuestionHints.length > 0 ||
      isShortResponse ||
      endsWithQuestion ||
      ctx.planMode ||
      hasCorrectionLanguage;

    if (needsLLMCheck) {
      const effectiveHints =
        questionCheck.type === "conversational" ? [] : regexQuestionHints;

      const priorErrorSection = hasPriorActionableErrors
        ? `\nPRIOR ACTIONABLE ERROR / FEEDBACK:\n${formatPriorErrorContext(priorErrorContext)}\n`
        : "";
      const questionHintSection =
        effectiveHints.length > 0
          ? `\n=== QUESTION PATTERNS DETECTED (REGEX) ===\nThe following patterns were detected by regex and may be false positives:\n${effectiveHints.join("\n")}\n\nNOTE: Use these as a hint but classify based on the full context. Conversational responses, small talk, and polite offers to elaborate are OK even if they match question patterns.\n=== END HINT ===\n`
          : "";
      const predictionSection = prediction
        ? `\n=== USER SENTIMENT (CURRENT PREDICTION) ===\n${formatPredictionContext(prediction)}\nFrustration streak: ${frustrationStreak}\n=== END SENTIMENT ===\n`
        : "";

      const context =
        `USER MESSAGE:\n${userText}\n${priorErrorSection}${questionHintSection}${predictionSection}\nASSISTANT RESPONSE:\n${assistantText}`;

      const classifyResult = await runAgent(
        { ...CLASSIFY_STOP_RESPONSE_AGENT_CONFIG, workingDir: ctx.projectDir },
        { prompt: "Classify this response.", context }
      ).catch(() => ({ output: "OK" }));

      const normalizedOutput = classifyResult.output.trim().toUpperCase();

      if (normalizedOutput.includes("IGNORED_ERROR")) {
        return { stopBlock: IGNORED_ERROR_SYSTEM_MESSAGE };
      } else if (normalizedOutput.includes("PLAN_APPROVAL")) {
        return { stopBlock: PLAN_APPROVAL_SYSTEM_MESSAGE };
      } else if (normalizedOutput.includes("MISUNDERSTOOD")) {
        return { stopBlock: MISUNDERSTOOD_SYSTEM_MESSAGE };
      } else if (normalizedOutput.includes("QUESTION")) {
        // Priority fix: when the user is hostile, asking-instead-of-acting IS stalling.
        // The "use AskUserQuestion" feedback misdiagnoses a stall as a UX nit. Emit the
        // hostile-stall message so the assistant resumes the demanded task.
        return { stopBlock: isHostile ? HOSTILE_STALL_SYSTEM_MESSAGE : QUESTION_SYSTEM_MESSAGE };
      }
      // classification === "OK" — fall through
    }

    // Check 2: User asked a question that wasn't addressed (preserved verbatim)
    const userQuestion = extractUserQuestion(userText);
    if (userQuestion) {
      const strippedAssistant = stripQuotedContent(assistantText);
      if (strippedAssistant.length < 50) {
        if (/^(?:I'll|Let me|Sure|OK|Okay|Got it|Understood)/.test(assistantText)) {
          const verifyResult = await runAgent(
            { ...VERIFY_USER_QUESTION_AGENT_CONFIG, workingDir: ctx.projectDir },
            {
              prompt: "Is this an actual question?",
              context:
                `FULL USER MESSAGE:\n${userText}\n\nEXTRACTED TEXT (potential question):\n${userQuestion}\n\nIs the extracted text an actual question the user wants answered?`,
            }
          ).catch(() => ({ output: "NOT_QUESTION" }));

          const verifyTrimmed = verifyResult.output.trim().toUpperCase();
          const isQuestion =
            verifyTrimmed.includes("QUESTION") && !verifyTrimmed.includes("NOT_QUESTION");

          if (isQuestion) {
            return {
              stopBlock:
                `${USER_QUESTION_NOT_ANSWERED_SYSTEM_MESSAGE_PREFIX}${userQuestion}"\nPlease respond to what they asked.`,
            };
          }
        }
      }
    }

    return null;
  },
};

/**
 * Re-export getMostRecentMessage so stop-response-check.ts can import it
 * from the rules module without a direct transcript import.
 */
export { getMostRecentMessage } from "../utils/transcript.js";
