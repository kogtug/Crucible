import { isJsonRpcError, type RawJsonRpcClient } from "./rawClient.js";

/**
 * Reserved for the MCP specification per the draft's error code allocation
 * policy (-32020 to -32099). This specific code is assigned to
 * UnsupportedProtocolVersionError.
 * Source: modelcontextprotocol/modelcontextprotocol, schema/draft/schema.ts
 */
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

export type ProbeOutcome =
  | { era: "modern"; supportedVersions: string[]; discoverResult: Record<string, unknown> }
  | { era: "modern-version-mismatch"; supportedVersions: string[]; requested: string }
  | { era: "legacy" };

/**
 * Implements the three-outcome `server/discover` probe described in the
 * draft spec's stdio transport page ("Backward Compatibility"):
 *
 *  1. A valid DiscoverResult comes back -> the server is modern.
 *  2. A recognized UnsupportedProtocolVersionError (-32022) comes back -> the
 *     server is modern but doesn't support the requested version. The spec
 *     is explicit that this must NOT fall back to `initialize`.
 *  3. Any other error, or no response within a timeout -> the server is
 *     legacy. Fall back to the classic `initialize` handshake.
 *
 * This is intentionally not keyed to one specific error code for the legacy
 * case, matching the spec's own warning that legacy servers respond to
 * unknown pre-initialize methods with implementation-defined errors (often
 * -32601 or -32602) or don't respond at all.
 */
export async function probeServerEra(
  client: RawJsonRpcClient,
  preferredVersion: string,
  clientInfo: { name: string; version: string } = { name: "crucible-probe", version: "0.1.0" },
): Promise<ProbeOutcome> {
  let response;
  try {
    response = await client.request("server/discover", {
      meta: {
        "io.modelcontextprotocol/protocolVersion": preferredVersion,
        "io.modelcontextprotocol/clientInfo": clientInfo,
        "io.modelcontextprotocol/clientCapabilities": {},
      },
      timeoutMs: 3000,
    });
  } catch {
    return { era: "legacy" };
  }

  if (!isJsonRpcError(response)) {
    const result = response.result;
    const supportedVersions = Array.isArray(result.supportedVersions)
      ? (result.supportedVersions as string[])
      : [];
    return { era: "modern", supportedVersions, discoverResult: result };
  }

  if (response.error.code === UNSUPPORTED_PROTOCOL_VERSION) {
    const data = response.error.data as { supported?: string[]; requested?: string } | undefined;
    return {
      era: "modern-version-mismatch",
      supportedVersions: data?.supported ?? [],
      requested: data?.requested ?? preferredVersion,
    };
  }

  return { era: "legacy" };
}

/**
 * String comparison is correct here because MCP protocol versions are
 * zero-padded ISO dates ("2026-07-28", "2025-11-25"): lexicographic order
 * on strings of this exact shape is the same as chronological order. This
 * intentionally avoids pulling in a date-parsing dependency for something
 * this simple - see docs/architecture.md for why.
 */
export function protocolVersionAtLeast(version: string, minimum: string): boolean {
  return version >= minimum;
}
