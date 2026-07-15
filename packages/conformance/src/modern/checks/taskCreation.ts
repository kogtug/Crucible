import { isJsonRpcError } from "@crucible/core";
import type { ModernCheck, ModernCheckContext } from "../types.js";
import type { CheckResult } from "../../types.js";
import { serverAdvertisesTasks, tasksNotAdvertisedResult, TASKS_EXTENSION } from "../tasksExtension.js";

const TASK_TOOL_NAME = "slow_echo";
const MAX_POLLS = 20;
const POLL_DELAY_MS = 50;

function withMcpName(ctx: ModernCheckContext, mcpName: string): { mcpName?: string } {
  return ctx.client.getTarget().kind === "http" ? { mcpName } : {};
}

/**
 * Exercises the Tasks extension's (SEP-2663) core flow: declare the
 * extension capability, call a tool that supports task augmentation,
 * confirm the CreateTaskResult shape, poll tasks/get until the task
 * reaches a terminal state, and confirm the terminal GetTaskResult's shape
 * - most importantly that resultType has switched to "complete", not left
 * at "task". That specific switch is easy to get backwards (this check's
 * own reference implementation initially got it right only because it was
 * written directly from the spec's explicit MUST, not by intuition), which
 * is exactly why CRUCIBLE_BREAK=task-resulttype-not-complete exists as a
 * fixture mode to prove this check would catch getting it wrong.
 */
export const taskCreationConformance: ModernCheck = {
  id: "task-creation-conformance",
  title: "Tasks extension: create-and-poll flow returns correctly-shaped results",
  specRef: "SEP-2663 (Tasks extension): Task Creation, Task Polling",

  async run(ctx: ModernCheckContext): Promise<CheckResult> {
    if (!serverAdvertisesTasks(ctx.discoverResult)) return tasksNotAdvertisedResult(this);

    const meta = {
      "io.modelcontextprotocol/protocolVersion": ctx.negotiatedVersion,
      "io.modelcontextprotocol/clientCapabilities": { extensions: { [TASKS_EXTENSION]: {} } },
    };

    const createResponse = await ctx.client.request("tools/call", {
      meta,
      params: { name: TASK_TOOL_NAME, arguments: { message: "crucible-task-check", delayMs: 150 } },
      ...withMcpName(ctx, TASK_TOOL_NAME),
      timeoutMs: 5000,
    });

    if (isJsonRpcError(createResponse)) {
      return {
        id: this.id,
        title: this.title,
        status: "fail",
        message: `tools/call for '${TASK_TOOL_NAME}' returned an error even though the extension is advertised: ${createResponse.error.message}`,
        specRef: this.specRef,
      };
    }

    const created = createResponse.result;
    const createProblems: string[] = [];
    if (created.resultType !== "task") createProblems.push(`resultType is ${JSON.stringify(created.resultType)}, expected "task"`);
    if (typeof created.taskId !== "string" || created.taskId.length === 0) createProblems.push("taskId is missing or not a non-empty string");
    if (created.status !== "working" && created.status !== "completed") {
      createProblems.push(`status is ${JSON.stringify(created.status)}, expected "working" (or "completed", if it finished immediately)`);
    }
    if (typeof created.createdAt !== "string") createProblems.push("createdAt is missing or not a string");
    if (typeof created.ttlMs !== "number") createProblems.push("ttlMs is missing or not a number");

    if (createProblems.length > 0) {
      return {
        id: this.id,
        title: this.title,
        status: "fail",
        message: `CreateTaskResult shape problems: ${createProblems.join("; ")}. Got: ${JSON.stringify(created)}`,
        specRef: this.specRef,
      };
    }

    const taskId = created.taskId as string;
    let terminal: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
      const pollResponse = await ctx.client.request("tasks/get", {
        meta,
        params: { taskId },
        ...withMcpName(ctx, taskId),
        timeoutMs: 5000,
      });
      if (isJsonRpcError(pollResponse)) {
        return {
          id: this.id,
          title: this.title,
          status: "fail",
          message: `tasks/get failed while polling: ${pollResponse.error.message}`,
          specRef: this.specRef,
        };
      }
      if (pollResponse.result.status !== "working") {
        terminal = pollResponse.result;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_DELAY_MS));
    }

    if (!terminal) {
      return {
        id: this.id,
        title: this.title,
        status: "fail",
        message: `Task never left 'working' after ${MAX_POLLS} polls (~${MAX_POLLS * POLL_DELAY_MS}ms) - either it's genuinely slower than that, or it's stuck.`,
        specRef: this.specRef,
      };
    }

    const terminalProblems: string[] = [];
    if (terminal.resultType !== "complete") {
      terminalProblems.push(
        `resultType on the terminal tasks/get response is ${JSON.stringify(terminal.resultType)}, expected "complete" (the request itself completed, even though the task's own status may differ)`,
      );
    }
    if (terminal.status !== "completed") {
      terminalProblems.push(`status is ${JSON.stringify(terminal.status)}, expected "completed"`);
    }
    if (typeof terminal.result !== "object" || terminal.result === null) {
      terminalProblems.push("result is missing on a completed task");
    }

    if (terminalProblems.length > 0) {
      return {
        id: this.id,
        title: this.title,
        status: "fail",
        message: `Terminal GetTaskResult shape problems: ${terminalProblems.join("; ")}. Got: ${JSON.stringify(terminal)}`,
        specRef: this.specRef,
      };
    }

    return {
      id: this.id,
      title: this.title,
      status: "pass",
      message: `Task ${taskId} was created (resultType 'task'), polled to completion, and the terminal tasks/get response correctly reported resultType 'complete' with a valid result.`,
      specRef: this.specRef,
    };
  },
};
