/**
 * Minimal structured logger. Single line JSON to stdout so it plays well with
 * container log collectors. Never logs secrets — callers pass explicit fields.
 */
type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const lvl = (process.env.LOG_LEVEL?.trim() as Level) || "info";
  return ORDER[lvl] ?? ORDER.info;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < threshold()) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  const line = JSON.stringify(record);
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function make(bindings: Record<string, unknown>): Logger {
  const merge = (fields?: Record<string, unknown>) => ({ ...bindings, ...fields });
  return {
    debug: (m, f) => emit("debug", m, merge(f)),
    info: (m, f) => emit("info", m, merge(f)),
    warn: (m, f) => emit("warn", m, merge(f)),
    error: (m, f) => emit("error", m, merge(f)),
    child: (b) => make({ ...bindings, ...b }),
  };
}

export const logger: Logger = make({});
