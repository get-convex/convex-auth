/**
 * Leveled console logging shared across auth internals.
 *
 * @module
 */

/** Supported log severities, ordered from most to least severe. */
export const LOG_LEVELS = {
  ERROR: "ERROR",
  WARN: "WARN",
  INFO: "INFO",
  DEBUG: "DEBUG",
} as const;

/** One of the {@link LOG_LEVELS} severity names. */
export type LogLevel = keyof typeof LOG_LEVELS;

function serialize(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return `${value.message}${value.stack ? `\n${value.stack}` : ""}`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const LEVEL_SEVERITY: Record<LogLevel, number> = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
};

/**
 * Format and emit a log line, suppressing anything below `configuredLogLevel`.
 *
 * The level gate is checked before {@link serialize} runs, so a message gated
 * out by the configured level never pays the `JSON.stringify` cost of its args.
 *
 * @param module - Source module label included in the prefix.
 * @param level - Severity of this message.
 * @param args - Values to serialize and join into the message body.
 * @param configuredLogLevel - Minimum level to emit. Defaults to `"INFO"`.
 */
export function logMessage(
  module: string,
  level: LogLevel,
  args: readonly unknown[],
  configuredLogLevel: LogLevel = "INFO",
) {
  if (LEVEL_SEVERITY[level] > LEVEL_SEVERITY[configuredLogLevel]) {
    return;
  }

  const message = args.map(serialize).join(" ");
  const prefix = `[${module}] [${level}]`;

  switch (level) {
    case "ERROR":
      console.error(prefix, message);
      return;
    case "WARN":
      console.warn(prefix, message);
      return;
    case "INFO":
      console.info(prefix, message);
      return;
    case "DEBUG":
      console.debug(prefix, message);
      return;
  }
}
