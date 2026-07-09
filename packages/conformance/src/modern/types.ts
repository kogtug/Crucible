import type { RawJsonRpcClient } from "@crucible/core";
import type { CheckResult } from "../types.js";

export interface ModernCheckContext {
  client: RawJsonRpcClient;
  /** The protocol version the target confirmed via server/discover. */
  negotiatedVersion: string;
  /** The raw DiscoverResult the probe already retrieved, so checks that only care about it don't need a second round trip. */
  discoverResult: Record<string, unknown>;
}

export interface ModernCheck {
  id: string;
  title: string;
  specRef?: string;
  run(ctx: ModernCheckContext): Promise<CheckResult>;
}
