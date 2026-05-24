import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { runAgent, type AgentConfig } from "../utils/agent-runner.js";
import { MODEL_TIERS } from "../types.js";
import { readTranscriptExact, formatTranscriptResult } from "../utils/transcript.js";
import { QUESTION_VALIDATE_COUNTS } from "../utils/transcript-presets.js";

/**
 * Verbatim copy of QUESTION_VALIDATE_AGENT.systemPrompt from agent-configs.ts.
 * Output contract: ALLOW or BLOCK: <feedback>
 */
const QUESTION_VALIDATE_SYSTEM_PROMPT = `You validate AskUserQuestion tool calls before showing to user.

You will receive:
1. QUESTIONS: The questions Claude wants to ask (with options)
2. CONVERSATION: Full user message history and recent assistant messages
3. RECENT TOOL CALLS: What Claude has done recently

BLOCK if ANY of these apply:

1. GIT OPERATIONS - Question asks about committing, pushing, or git workflow:
   - "Should I commit these changes?" → BLOCK: User handles commits via the commit workflow
   - "Want me to push?" → BLOCK: User handles pushing via the push workflow
   - Any question about git operations → BLOCK: User manages git workflow

   EXCEPTION: If user invoked the commit or push workflow, git-related questions ARE allowed:
   - Which repositories to commit/push (multi-repo selection)
   - Model tier for code review (opus/sonnet/haiku)
   - Confirm review depth (Default/In depth/Broad-minimal)
   These are part of the commit and push workflows and should be ALLOWED.

2. UNSEEN CONTENT - Question asks about content not yet shown to user:
   - "Which approach in the plan do you prefer?" but plan wasn't displayed
   - References to files, plans, or analysis results user hasn't seen
   - Look for: Write/Edit to plan files WITHOUT subsequent Read or /plan command
   EXCEPTION: If the assistant's prior text messages SUMMARIZE or DESCRIBE the referenced
   content, the user HAS seen it. Only block if content was written to a file with NO summary
   in chat. KEY TEST: Does the user need the RAW CONTENT to answer, or is the conversation
   summary sufficient? High-level direction questions ("what should we explore next?") do NOT
   require raw content.

3. ALREADY ANSWERED - User explicitly stated preference that answers this:
   - User said "I want option X" earlier → don't ask about X vs Y
   - User said "don't do Z" earlier → don't offer Z as an option
   - Only block if 90%+ confident the prior statement directly answers ALL questions
   - PARTIAL OVERLAP: If a multi-question tool has some already-answered items AND some NEW items, ALLOW it — the new items still need user input. Do not block the entire question set just because one sub-question was answered.

4. WORKFLOW VIOLATION - Question violates expected flow:
   - In plan mode: asking implementation questions before plan is approved
   - Asking about next steps when current task isn't done

5. REDUNDANT AFTER CLARIFICATION - User already gave explicit short directive:
   - User's recent message was brief and clear (e.g., "README", "the tests", "fix it")
   - Claude now asks multi-option question about the SAME topic
   - This forces user to re-explain what they just said
   - BLOCK: Respect the user's explicit direction without re-asking

ALLOW if:
- Question clarifies genuine ambiguity in user's request
- User has context needed to answer (content was shown)
- Question is on-topic and hasn't been answered

IMPORTANT - FRUSTRATED USER DOES NOT MEAN BLOCK ALL QUESTIONS:
- When user is frustrated about HOW things were presented (e.g., "just present me the situation", "stop changing your mind"), this is about communication STYLE, not about whether questions should be asked
- If the assistant has NEW decisions or different topics to ask about, AskUserQuestion is still appropriate
- Only block if the question asks about something the user ALREADY decided or explicitly said to skip
- A user saying "do the edits" about items A and B does NOT mean "never ask me about item C"
- When consensus/analysis recommends a clear action and user previously agreed to similar actions, proceeding without asking IS correct — but if the question introduces a genuinely new decision, ALLOW it

OUTPUT FORMAT (exactly one):

ALLOW
or
BLOCK: <feedback for Claude explaining what to do instead>

Examples of good BLOCK feedback:
- "Show the plan to user first with /plan or by reading the file, then ask"
- "User already said they want 'maximum code reduction' - proceed with that"
- "Complete the current task before asking about next steps"`;

const QUESTION_VALIDATE_AGENT_CONFIG: Omit<AgentConfig, "workingDir"> = {
  name: "question-validate",
  tier: MODEL_TIERS.HAIKU,
  mode: "direct",
  maxTokens: 500,
  systemPrompt: QUESTION_VALIDATE_SYSTEM_PROMPT,
  formatValidation: {
    validator: /^(ALLOW|BLOCK:)/,
    formatReminder: "Reply with exactly: ALLOW or BLOCK: <feedback>",
    fallbackOutput: "ALLOW",
  },
};

/**
 * AskUserQuestion tool input structure.
 */
interface AskUserQuestionInput {
  questions: Array<{
    question: string;
    header: string;
    options: Array<{
      label: string;
      description: string;
    }>;
    multiSelect: boolean;
  }>;
}

function formatQuestions(input: AskUserQuestionInput): string {
  return input.questions
    .map((q, i) => {
      const options = q.options
        .map((opt) => `  - ${opt.label}: ${opt.description}`)
        .join("\n");
      return `Question ${i + 1} [${q.header}]: ${q.question}\nOptions:\n${options}`;
    })
    .join("\n\n");
}

export const questionValidateRule: PreToolRule = {
  name: "question-validate",
  displayName: "Question Validate",
  priority: 30,
  appealable: false,
  usesLlm: true,
  events: ["PreToolUse"],
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (ctx.toolName !== "AskUserQuestion") return null;

    const input = ctx.toolInput as AskUserQuestionInput;
    if (!input?.questions || !Array.isArray(input.questions) || input.questions.length === 0) {
      return null;
    }

    const tx = await readTranscriptExact(ctx.transcriptPath, QUESTION_VALIDATE_COUNTS).catch(() => null);
    const conv = tx ? formatTranscriptResult(tx) : "";
    if (!conv.trim()) return null;

    const formattedQuestions = formatQuestions(input);

    const result = await runAgent(
      { ...QUESTION_VALIDATE_AGENT_CONFIG, workingDir: ctx.projectDir },
      {
        prompt: "Check if these questions are appropriate to show to the user.",
        context: `QUESTIONS:\n${formattedQuestions}\n\nCONVERSATION AND TOOL HISTORY:\n${conv}`,
      }
    ).catch(() => ({ output: "ALLOW", success: false }));

    const text = result.output.trim();
    if (text.startsWith("BLOCK:")) {
      return { fastDeny: text.slice(6).trim() };
    }
    return null;
  },
};
