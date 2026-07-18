import { errorMessage } from "./output.js";

export type BackgroundErrorCallback<Context> = (
  error: unknown,
  context: Context,
) => void;

export type BackgroundErrorReportOptions<Context> = {
  error: unknown;
  context: Context;
  onBackgroundError?: BackgroundErrorCallback<Context>;
  renderMessage: (error: unknown, context: Context) => string;
  reportingFailurePrefix: string;
};

/** Report an asynchronous failure without allowing a reporting callback to escape. */
export function reportBackgroundError<Context>(
  options: BackgroundErrorReportOptions<Context>,
): void {
  try {
    if (options.onBackgroundError) {
      options.onBackgroundError(options.error, options.context);
      return;
    }
    process.stderr.write(`${options.renderMessage(options.error, options.context)}\n`);
  } catch (reportingError) {
    process.stderr.write(
      `${options.reportingFailurePrefix}: ${errorMessage(reportingError)}\n`,
    );
  }
}
