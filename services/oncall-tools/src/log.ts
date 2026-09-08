import pino from "pino";
import { config } from "./config.js";

export const logger = pino({
  level: config.logLevel,
  base: { service: "oncall-tools" },
});

export type Logger = typeof logger;
