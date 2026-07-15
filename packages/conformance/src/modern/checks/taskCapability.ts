import { isJsonRpcError } from "@crucible/core";
import type { ModernCheck, ModernCheckContext } from "../types.js";
import type { CheckResult } from "../../types.js";
import { serverAdvertisesTasks, tasksNotAdvertisedResult } from "../tasksExtension.js";

const TASK_TOOL_NAME = "slow_echo";

/**
 * SEP-2663 is explicit: a server "MUST NOT return a CreateTaskResult ...
 * to a client that did not include the [tasks] capability" in that
 * request's _meta. This calls the same task-augmentable tool as
 * taskCreationConformance, but *without* declaring the extension, and
 * expects an ordinary synchronous result back - not a task the client
 * never asked for and has no way to know how to poll.
 * CRUCIBLE_BREAK=task-without-capability makes the fixture violate this
 * deliberately, so there's a real negative case, not just a positive one.
 */
export const taskCapabilityConformance: ModernCheck = {
  id: "task-capability-conformance",
  title: "Tasks extension: no task is created for a client that didn't ask for one",
  specRef: "SEP-2663 (Tasks extension): Capability Negotiation",

  async run(ctx: ModernCheckContext): Promise<CheckResult> {
    if (!serverAdvertisesTasks(ctx.discoverResult)) return tasksNotAdvertisedResult(this);

    const response = await ctx.client.request("tools/call", {
      meta: { "io.modelcontextprotocol/protocolVersion": ctx.negotiatedVersion },
      params: { name: TASK_TOOL_NAME, arguments: { message: "crucible-no-task-check", delayMs: 30 } },
      ...(ctx.client.getTarget().kind === "http" ? { mcpName: TASK_TOOL_NAME } : {}),
      timeoutMs: 5000,
    });

    if (isJsonRpcError(response)) {
      return {
        id: this.id,
        title: this.title,
        status: "fail",
        message: `tools/call for '${TASK_TOOL_NAME}' returned an error: ${response.error.message}`,
        specRef: this.specRef,
      };
    }

    if (response.result.resultType === "task") {
      return {
        id: this.id,
        title: this.title,
        status: "fail",
        message:
          "Server returned a CreateTaskResult (resultType 'task') even though this request never declared the Tasks extension capability - the client has no way to know it should poll for this.",
        specRef: this.specRef,
      };
    }

    if (response.result.resultType !== "complete") {
      return {
        id: this.id,
        title: this.title,
        status: "fail",
        message: `Expected an ordinary resultType 'complete' response, got ${JSON.stringify(response.result.resultType)}.`,
        specRef: this.specRef,
      };
    }

    return {
      id: this.id,
      title: this.title,
      status: "pass",
      message: "Correctly returned an ordinary synchronous result rather than creating a task the client never asked for.",
      specRef: this.specRef,
    };
  },
};
