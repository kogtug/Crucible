import type { McpHarness } from "@cruciblemcp/core";
import type { Check, CheckResult } from "../types.js";

/**
 * Confirms tools/list returns schema-valid tool definitions: every tool has
 * a name, and every declared inputSchema is an object-typed JSON Schema.
 *
 * Why this still matters even though the TypeScript SDK's own types pin
 * inputSchema.type to the literal "object": that guarantee only holds for
 * servers written with this particular SDK. MCP servers are commonly written
 * in Python, Go, and other languages with no shared compiler to catch this,
 * so a runtime check against the wire format is the only thing that actually
 * protects a polyglot ecosystem.
 */
export const toolsListSchema: Check = {
  id: "tools-list-schema",
  title: "tools/list returns schema-valid tool definitions",
  specRef: "MCP spec section: Server Features / Tools",

  async run(harness: McpHarness): Promise<CheckResult> {
    const capabilities = harness.getServerCapabilities();

    if (!capabilities?.tools) {
      return {
        id: this.id,
        title: this.title,
        status: "warn",
        message:
          "Server did not advertise the 'tools' capability during initialize - skipping tools/list checks.",
        specRef: this.specRef,
      };
    }

    const { tools } = await harness.raw().listTools();

    if (!Array.isArray(tools)) {
      return {
        id: this.id,
        title: this.title,
        status: "fail",
        message: "tools/list did not return a 'tools' array.",
        specRef: this.specRef,
      };
    }

    const problems: string[] = [];
    for (const tool of tools) {
      if (!tool.name || typeof tool.name !== "string") {
        problems.push("a tool is missing a string 'name'");
        continue;
      }
      if (tool.inputSchema && (tool.inputSchema as { type?: string }).type !== "object") {
        problems.push(
          `tool '${tool.name}' has an inputSchema whose top-level type is not 'object'`,
        );
      }
    }

    if (problems.length > 0) {
      return {
        id: this.id,
        title: this.title,
        status: "fail",
        message: `Found ${problems.length} problem(s): ${problems.join("; ")}.`,
        specRef: this.specRef,
      };
    }

    return {
      id: this.id,
      title: this.title,
      status: "pass",
      message: `${tools.length} tool(s) reported, all with valid names and object-typed input schemas.`,
      specRef: this.specRef,
    };
  },
};
