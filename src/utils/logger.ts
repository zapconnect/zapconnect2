// src/utils/logger.ts
import util from "util";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function shouldLog(level: LogLevel, current: LogLevel) {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[current];
}

function serializeArg(arg: any) {
  if (arg instanceof Error) {
    return {
      error: {
        name: arg.name,
        message: arg.message,
        stack: arg.stack,
      },
    };
  }
  if (typeof arg === "string" || typeof arg === "number" || typeof arg === "boolean") {
    return arg;
  }
  return arg;
}

export function setupLogging() {
  const isProd = process.env.NODE_ENV === "production";
  const envLevel = (process.env.LOG_LEVEL || "info").toLowerCase() as LogLevel;
  const currentLevel: LogLevel = LEVEL_ORDER[envLevel] ? envLevel : "info";

  const raw = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug ? console.debug.bind(console) : console.log.bind(console),
  };

  const emit = (level: LogLevel, args: any[]) => {
    if (!shouldLog(level, currentLevel)) return;

    const ts = new Date().toISOString();

    const payload: any = {
      ts,
      level,
    };

    if (args.length === 0) {
      payload.msg = "";
    } else if (typeof args[0] === "string") {
      payload.msg = args[0];
      if (args.length > 1) {
        const rest = args.slice(1).map(serializeArg);
        if (rest.length === 1) {
          payload.meta = rest[0];
        } else if (rest.length > 1) {
          payload.meta = rest;
        }
      }
    } else {
      payload.msg = "";
      const rest = args.map(serializeArg);
      payload.meta = rest.length === 1 ? rest[0] : rest;
    }

    if (isProd) {
      raw.log(JSON.stringify(payload));
    } else {
      const human = `[${payload.level.toUpperCase()}] ${payload.msg || ""}`;
      if (payload.meta !== undefined) {
        raw.log(human, payload.meta);
      } else {
        raw.log(human);
      }
    }
  };

  console.log = (...args: any[]) => emit("info", args);
  console.info = (...args: any[]) => emit("info", args);
  console.warn = (...args: any[]) => emit("warn", args);
  console.error = (...args: any[]) => emit("error", args);
  console.debug = (...args: any[]) => emit("debug", args);

  return { raw };
}
