import type { McpHarness } from "@cruciblemcp/core";
import type { Check, CheckResult } from "../types.js";

/**
 * Confirms the target server completed the MCP `initialize` handshake and
 * returned a well-formed serverInfo + capabilities block.
 *
 * Note on scope: the SDK's own Zod schemas already validate the shape of the
 * initialize response before `connect()` resolves, so a connected harness
 * with populated getters is a reliable signal that basic handshake
 * conformance passed. What this check does NOT catch: the *new*
 * 2026-07-28 stateless-transport header requirements (Mcp-Method /
 * MCP-Protocol-Version) - not because they're unimplemented (see
 * httpHeaderConformance in the modern check family, and "HTTP transport"
 * in docs/architecture.md), but because this check specifically exercises
 * the classic initialize-based handshake, which the new headers don't
 * apply to in the first place.
 */
export const handshakeConformance: Check = {
  id: "handshake-conformance",
  title: "Initialize handshake returns well-formed server info and capabilities",
  specRef: "MCP spec section: Base Protocol / Lifecycle - initialize",

  async run(harness: McpHarness): Promise<CheckResult> {
    if (!harness.isConnected()) {
      return {
        id: this.id,
        title: this.title,
        status: "fail",
        message:
          "Harness never reached a connected state - the initialize handshake did not complete.",
        specRef: this.specRef,
      };
    }

    const serverInfo = harness.getServerVersion();
    const capabilities = harness.getServerCapabilities();

    if (!serverInfo?.name || !serverInfo.version) {
      return {
        id: this.id,
        title: this.title,
        status: "fail",
        message:
          "Server did not report a valid { name, version } serverInfo block during initialize.",
        specRef: this.specRef,
      };
    }

    if (!capabilities || typeof capabilities !== "object") {
      return {
        id: this.id,
        title: this.title,
        status: "fail",
        message: "Server did not report a capabilities object during initialize.",
        specRef: this.specRef,
      };
    }

    const advertised = Object.keys(capabilities);
    return {
      id: this.id,
      title: this.title,
      status: "pass",
      message: `Server identified itself as ${serverInfo.name}@${serverInfo.version} and negotiated capabilities: ${
        advertised.length > 0 ? advertised.join(", ") : "(none advertised)"
      }.`,
      specRef: this.specRef,
    };
  },
};
