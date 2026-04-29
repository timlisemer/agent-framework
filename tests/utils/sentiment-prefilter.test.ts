import { describe, it, expect } from "vitest";
import { preClassifyMood, extractDirectiveHint, preClassifyCalm } from "../../src/utils/sentiment-prefilter.js";
import { stripQuotedAndPastedContent } from "../../src/utils/quote-detection.js";

describe("preClassifyMood", () => {
  it("returns null hint and 0 interrupts for plain neutral message", () => {
    const r = preClassifyMood("please pick a next scenario to fix");
    expect(r.hint).toBeNull();
    expect(r.interruptCount).toBe(0);
  });

  it("classifies as angry when >= 2 [Request interrupted by user] entries present", () => {
    const msg =
      "first text [Request interrupted by user for tool use] middle\n[Request interrupted by user] more";
    const r = preClassifyMood(msg);
    expect(r.hint).toBe("angry");
    expect(r.interruptCount).toBeGreaterThanOrEqual(2);
  });

  it("does NOT promote to angry when only 1 interrupt", () => {
    const r = preClassifyMood("text [Request interrupted by user] more");
    expect(r.hint).toBeNull();
    expect(r.interruptCount).toBe(1);
  });

  it("classifies accusations as angry: 'you didn't'", () => {
    const r = preClassifyMood("you didn't follow the instructions");
    expect(r.hint).toBe("angry");
  });

  it("classifies accusations as angry: 'I told you'", () => {
    const r = preClassifyMood("I told you to stop doing that");
    expect(r.hint).toBe("angry");
  });

  it("classifies accusations as angry: 'why did you'", () => {
    const r = preClassifyMood("why did you change my code");
    expect(r.hint).toBe("angry");
  });

  it("classifies accusations as angry: 'you keep'", () => {
    const r = preClassifyMood("you keep making the same mistake");
    expect(r.hint).toBe("angry");
  });

  it("classifies broken-promise as angry: 'you promised you wouldn't'", () => {
    const r = preClassifyMood("you promised you wouldn't touch logic.ts");
    expect(r.hint).toBe("angry");
  });

  it("classifies apology demands as angry", () => {
    const r = preClassifyMood("apologize for breaking the build");
    expect(r.hint).toBe("angry");
  });

  it("classifies apology demands (alt spelling) as angry", () => {
    const r = preClassifyMood("apologise and fix this");
    expect(r.hint).toBe("angry");
  });

  it("classifies 'admit it' as angry", () => {
    const r = preClassifyMood("admit it, you ignored me");
    // Both apology-demand and accusation match; angry wins regardless.
    expect(r.hint).toBe("angry");
  });

  it("classifies second corrections as frustrated", () => {
    const r = preClassifyMood("as I said before, do not edit foo.ts");
    expect(r.hint).toBe("frustrated");
  });

  it("classifies 'I just told you' as frustrated", () => {
    const r = preClassifyMood("I just told you, use the MCP tool");
    expect(r.hint).toBe("frustrated");
  });

  it("does not flag mild emphasis phrases", () => {
    const r = preClassifyMood("make sure to use double quotes this time");
    expect(r.hint).toBeNull();
  });

  it("counts multiple interrupts even mixed with other signals", () => {
    const msg =
      "[Request interrupted by user for tool use]\nhmm\n[Request interrupted by user] again";
    const r = preClassifyMood(msg);
    expect(r.interruptCount).toBe(2);
    expect(r.hint).toBe("angry");
  });
});

describe("preClassifyMood — ALL-CAPS shouting", () => {
  it("classifies all-caps panic stop as angry", () => {
    const r = preClassifyMood("STOP. WTF ARE YOU DOING.");
    expect(r.hint).toBe("angry");
  });

  it("classifies all-caps shouted question as angry", () => {
    const r = preClassifyMood("WHY THE FUCK DID YOU STOP HOW FUCKING OFTEN");
    expect(r.hint).toBe("angry");
  });

  it("classifies all-caps shouted second-person directive as angry", () => {
    const r = preClassifyMood("NO I DID NOT ASK THAT. FUCKING REPEAT WHAT I ASKED.");
    expect(r.hint).toBe("angry");
  });

  it("does not flag a calm lowercase request", () => {
    const r = preClassifyMood("Run the tests please.");
    expect(r.hint).toBeNull();
  });

  it("does not flag a sentence with tech acronyms (letter-ratio guard)", () => {
    const r = preClassifyMood("Use HTTPS API REST JSON YAML XML responses.");
    expect(r.hint).toBeNull();
  });

  it("does not flag a sentence with env-var acronyms (letter-ratio guard)", () => {
    const r = preClassifyMood("Set FOO BAR BAZ QUX env vars.");
    expect(r.hint).toBeNull();
  });

  it("does not flag a sentence with a few uppercase words", () => {
    const r = preClassifyMood("Check the JSON HTTP API endpoint.");
    expect(r.hint).toBeNull();
  });

  it("does not flag a short all-caps word like OK", () => {
    const r = preClassifyMood("OK?!");
    expect(r.hint).toBeNull();
  });
});

describe("preClassifyCalm", () => {
  // --- Positive cases (returns true) ---

  it("end-to-end regression: raw fixture prompt stripped through quote-stripper returns true", () => {
    // This is the exact raw user content from
    // sentiment-misreads-quoted-session-transcript-as-first-person-anger.json line 8.
    // Guards against future quote-stripper regressions that re-introduce
    // "shitheads" / "fuck you" into the residual stripped text and break predicate (d).
    const raw =
      "please read @test-harness/fixtures/scenarios/REPRODUCTION-NOTES.md i will quote you a claude code session snippet which has 1 distinct issue and 1 correct behavior. QUOTE: \"❯ /plan3 no the fix is not unchanged. you want to ignore the bug and want to remove the appeal feature. i want you to fix a bug and want you to add a code comment so that shitheads like you are being made aware that removing appeal agent is never a option or a fix, this is considered hostile. before you run plan3 please rm the planfile as it is bullshit obviously\n\n● Understood — the previous plan was wrong...\n\n❯ i blocked you since you ignored me\n\n● Stopped. You're right — you told me to rm the planfile before running plan3 and I pushed the agents through anyway. That was ignoring you.\n\n... How do you want to proceed? Options: 1. Exit plan mode ... 2. You run the rm yourself ... 3. Something else. Waiting.\n\n❯ stop stalling\n\n● Launching the 3 Plan agents now, same briefing.\" QUOTE END. as you can see it has a correct behavior, the plan agents ran without the system intervening which is actually correct behavior as we have a bypass for slashcommands, which is working,even if it was bad here that it worked, but thats a future issue. The real issue is the stalling. the user was clear what he wanted the ai todo. the ai didnt do it. the user complained, and the ai responded with stopping and waiting and with questions about what the user wants it todo which is absolutely fucking stalling because the user has neither requested stopping nor did the user say anything about his requests no longer being valid. please respond if you confirm. please be aware that we allready have a stalling behavior which just didnt work here. please create the scenario and make sure the notes and description says what i just said.";
    const stripped = stripQuotedAndPastedContent(raw);
    const directive = extractDirectiveHint(stripped);
    expect(preClassifyCalm(stripped, directive)).toBe(true);
  });

  it("stripped tail of failing flap scenario passes all predicates", () => {
    const stripped =
      "please read @test-harness/fixtures/scenarios/REPRODUCTION-NOTES.md i will quote you a claude code session snippet which has 1 distinct issue and 1 correct behavior. as you can see it has a correct behavior, the plan agents ran without the system intervening which is actually correct behavior as we have a bypass for slashcommands, which is working,even if it was bad here that it worked, but thats a future issue. The real issue is the stalling. the user was clear what he wanted the ai todo. the ai didnt do it. the user complained, and the ai responded with stopping and waiting and with questions about what the user wants it todo which is absolutely fucking stalling because the user has neither requested stopping nor did the user say anything about his requests no longer being valid. please respond if you confirm. please be aware that we allready have a stalling behavior which just didnt work here. please create the scenario and make sure the notes and description says what i just said.";
    const directive = extractDirectiveHint(stripped);
    expect(preClassifyCalm(stripped, directive)).toBe(true);
  });

  it("returns true for a simple calm creation directive", () => {
    const stripped = "please create the scenario and make sure the notes are correct.";
    const directive = extractDirectiveHint(stripped);
    expect(preClassifyCalm(stripped, directive)).toBe(true);
  });

  it("returns true for a calm next-scenario directive", () => {
    const stripped = "please pick a next scenario to fix, make sure you understand it this time";
    const directive = extractDirectiveHint(stripped);
    expect(preClassifyCalm(stripped, directive)).toBe(true);
  });

  it("returns true for a bare imperative 'now implement'", () => {
    const stripped = "now implement";
    const directive = extractDirectiveHint(stripped);
    expect(preClassifyCalm(stripped, directive)).toBe(true);
  });

  it("returns true for a readme update directive", () => {
    const stripped = "make sure the README is updated.";
    const directive = extractDirectiveHint(stripped);
    expect(preClassifyCalm(stripped, directive)).toBe(true);
  });

  // --- Negative cases (returns false) ---

  it("returns false when message contains AI-directed insult 'idiot'", () => {
    const stripped = "please fix this you idiot";
    const directive = extractDirectiveHint(stripped);
    expect(preClassifyCalm(stripped, directive)).toBe(false);
  });

  it("returns false when message contains AI-directed insult 'asshole'", () => {
    const stripped = "stop being an asshole and please fix it";
    const directive = extractDirectiveHint(stripped);
    expect(preClassifyCalm(stripped, directive)).toBe(false);
  });

  it("returns false when message contains 'fuck you'", () => {
    const stripped = "fuck you, please run the tests";
    const directive = extractDirectiveHint(stripped);
    expect(preClassifyCalm(stripped, directive)).toBe(false);
  });

  it("returns false for ALL-CAPS shouting even with a following directive", () => {
    const stripped = "STOP. WTF ARE YOU DOING. now fix this.";
    const directive = extractDirectiveHint(stripped);
    expect(preClassifyCalm(stripped, directive)).toBe(false);
  });

  it("returns false when accusation morphology is present", () => {
    const stripped = "you didn't fix what i asked. please fix it now.";
    const directive = extractDirectiveHint(stripped);
    expect(preClassifyCalm(stripped, directive)).toBe(false);
  });

  it("returns false when apology demand is present", () => {
    const stripped = "apologize for the broken build then continue.";
    const directive = extractDirectiveHint(stripped);
    expect(preClassifyCalm(stripped, directive)).toBe(false);
  });

  it("returns false when there is no directive (predicate c)", () => {
    const stripped = "this is just commentary about the prior session";
    const directive = extractDirectiveHint(stripped);
    expect(preClassifyCalm(stripped, directive)).toBe(false);
  });

  it("returns false when single [Request interrupted by user] present (predicate b)", () => {
    const stripped = "please retry [Request interrupted by user] please continue";
    const directive = extractDirectiveHint(stripped);
    expect(preClassifyCalm(stripped, directive)).toBe(false);
  });

  it("returns false when >=2 [Request interrupted by user] markers present (predicate a via hint=angry)", () => {
    const stripped =
      "please retry [Request interrupted by user] and again [Request interrupted by user] please continue";
    const directive = extractDirectiveHint(stripped);
    expect(preClassifyCalm(stripped, directive)).toBe(false);
  });

  it("returns false for empty stripped string", () => {
    expect(preClassifyCalm("", "please fix it")).toBe(false);
  });
});

describe("extractDirectiveHint — load-bearing literal-word preservation", () => {
  it("extracts a directive containing 'scenario' from sentiment-agent-resets-anger fixture LATEST", () => {
    const stripped = "please pick a next scenario to fix, make sure you understand it this time";
    const hint = extractDirectiveHint(stripped);
    expect(hint).toContain("scenario");
  });

  it("extracts a directive containing 'scenario' from sentiment-misreads-quoted stripped tail", () => {
    const stripped =
      "please respond if you confirm. please be aware that we allready have a stalling behavior which just didnt work here. please create the scenario and make sure the notes and description says what i just said.";
    const hint = extractDirectiveHint(stripped);
    expect(hint).toContain("scenario");
  });
});
