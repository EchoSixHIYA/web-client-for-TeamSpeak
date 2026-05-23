import pino from "pino";

export interface Logger {
  debug(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(logDir?: string): Logger {
  const targets: pino.TransportTargetOptions[] = [
    { target: "pino/file", options: { destination: 1 }, level: "info" },
  ];
  if (logDir) {
    targets.push({
      target: "pino/file",
      options: { destination: `${logDir}/webspeak.log` },
      level: "debug",
    });
  }

  const baseLogger = pino({
    level: "debug",
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(targets.length > 1 ? { transport: { targets } } : {}),
  });

  function wrap(l: pino.Logger): Logger {
    function doLog(
      level: "debug" | "info" | "warn" | "error",
      objOrMsg: Record<string, unknown> | string,
      msg?: string,
    ): void {
      if (typeof objOrMsg === "string") {
        l[level](objOrMsg);
      } else {
        l[level](objOrMsg, msg);
      }
    }

    return {
      debug: (objOrMsg: Record<string, unknown> | string, msg?: string) =>
        doLog("debug", objOrMsg, msg),
      info: (objOrMsg: Record<string, unknown> | string, msg?: string) =>
        doLog("info", objOrMsg, msg),
      warn: (objOrMsg: Record<string, unknown> | string, msg?: string) =>
        doLog("warn", objOrMsg, msg),
      error: (objOrMsg: Record<string, unknown> | string, msg?: string) =>
        doLog("error", objOrMsg, msg),
      child: (bindings: Record<string, unknown>) => wrap(l.child(bindings)),
    };
  }

  return wrap(baseLogger);
}
