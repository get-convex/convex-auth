import { logMessage, type LogLevel } from "../../shared/log";
import { configDefaults } from "../config";
import type { ConvexAuthConfig } from "../types";
import { createProviderRegistry } from "./providers";

const logger = {
  log: (level: LogLevel, ...args: unknown[]) => logMessage("convex-auth", level, args),
};

export function resolveServerServices(config: ConvexAuthConfig) {
  const configValue = configDefaults(config);
  const providerRegistry = createProviderRegistry(configValue, logger);

  return {
    config: configValue,
    providerRegistry,
  };
}

export type ServerServices = ReturnType<typeof resolveServerServices>;
