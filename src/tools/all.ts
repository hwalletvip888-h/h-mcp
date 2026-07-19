import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerBalanceTools } from "./balance.js";
import { registerGatewayTools } from "./gateway.js";
import { registerTxHistoryTools } from "./txhistory.js";
import { registerDefiTools } from "./defi.js";
import { registerPaymentsTools } from "./payments.js";
import { registerTradeTools } from "./trade.js";
import { registerIntentTools } from "./intent.js";
import { registerMarketTools } from "./market.js";
import { registerWsTools } from "./ws.js";
import { registerSkillTools } from "./skills.js";
import { registerHelpTools } from "./help.js";

export function registerAllTools(server: McpServer, auth: ReturnType<typeof import("../adapters/shared.js").resolveAuth>) {
  registerBalanceTools(server, auth);
  registerGatewayTools(server, auth);
  registerTxHistoryTools(server, auth);
  registerDefiTools(server, auth);
  registerPaymentsTools(server, auth);
  registerTradeTools(server, auth);
  registerIntentTools(server, auth);
  registerMarketTools(server, auth);
  registerWsTools(server, auth);
  registerSkillTools(server, auth);
  registerHelpTools(server, auth);
}
