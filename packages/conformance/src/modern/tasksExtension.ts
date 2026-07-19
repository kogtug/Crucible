import type { CheckResult } from "../types.js";

export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

/** Whether a server/discover result's capabilities advertise the Tasks extension (SEP-2663). */
export function serverAdvertisesTasks(discoverResult: Record<string, unknown>): boolean {
  const extensions = (
    discoverResult.capabilities as { extensions?: Record<string, unknown> } | undefined
  )?.extensions;
  return extensions !== undefined && TASKS_EXTENSION in extensions;
}

/** The standard "doesn't apply" result for a Tasks check run against a server that doesn't advertise the extension. */
export function tasksNotAdvertisedResult(check: {
  id: string;
  title: string;
  specRef?: string;
}): CheckResult {
  return {
    id: check.id,
    title: check.title,
    status: "warn",
    message: `Server does not advertise the ${TASKS_EXTENSION} extension in server/discover - skipping.`,
    specRef: check.specRef,
  };
}
