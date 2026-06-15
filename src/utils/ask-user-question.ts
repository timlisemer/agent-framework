interface RawQuestionOption {
  label?: unknown;
  description?: unknown;
}

interface RawQuestion {
  question?: unknown;
  header?: unknown;
  options?: unknown;
}

export interface NormalizedAskUserQuestion {
  question: string;
  header: string;
  options: Array<{
    label: string;
    description: string;
  }>;
}

export function normalizeAskUserQuestions(input: unknown): NormalizedAskUserQuestion[] {
  const raw = input as { questions?: unknown } | undefined;
  if (!Array.isArray(raw?.questions)) return [];
  return raw.questions.map((item) => {
    if (!item || typeof item !== "object") {
      return { question: "", header: "", options: [] };
    }
    const question = item as RawQuestion;
    const options = Array.isArray(question.options) ? question.options as RawQuestionOption[] : [];
    return {
      question: typeof question.question === "string" ? question.question : "",
      header: typeof question.header === "string" ? question.header : "",
      options: options.map((option) => ({
        label: typeof option.label === "string" ? option.label : "",
        description: typeof option.description === "string" ? option.description : "",
      })).filter((option) => option.label || option.description),
    };
  });
}

export function formatAskUserQuestionsForValidation(input: unknown): string {
  return normalizeAskUserQuestions(input)
    .map((question, index) => {
      const options = question.options
        .map((option) => `  - ${option.label}: ${option.description}`)
        .join("\n");
      return `Question ${index + 1} [${question.header}]: ${question.question}\nOptions:\n${options}`;
    })
    .join("\n\n");
}

export function formatAskUserQuestionsForStallingJudge(input: unknown): string {
  return normalizeAskUserQuestions(input)
    .map((question, index) => {
      const headerLine = question.header ? `Header: ${question.header}\n` : "";
      const options = question.options
        .map((option) => option.description ? `${option.label} - ${option.description}` : option.label)
        .join(" | ");
      return `Q${index + 1}:\n${headerLine}Question: ${question.question}${options ? `\nOptions: ${options}` : ""}`;
    })
    .join("\n\n");
}

export function summarizeAskUserQuestions(input: unknown, quote: (value: string) => string): string {
  const questions = normalizeAskUserQuestions(input);
  const perQuestion = questions.map((question, index) => {
    const labels = question.options
      .map((option) => option.label)
      .filter(Boolean)
      .join(" | ");
    return `#${index}:{header=${quote(question.header)}, question=${quote(question.question)}, options.length=${question.options.length}${labels ? `, labels=${quote(labels)}` : ""}}`;
  }).join(", ");
  return `AskUserQuestion(questions.length=${questions.length}${perQuestion ? "; " + perQuestion : ""})`;
}
