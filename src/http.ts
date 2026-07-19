/**
 * hchain-skills Server — HTTP 传输层 (stateless)
 * 规范: MCP Streamable HTTP Protocol
 * v1.6.0: stateless mode with sessionIdGenerator: undefined
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { resolveAuth } from "./adapters/shared.js";
import { logger, nextCorrelationId } from "./adapters/logger.js";
import { registerBalanceTools } from "./tools/balance.js";
import { registerGatewayTools } from "./tools/gateway.js";
import { registerTxHistoryTools } from "./tools/txhistory.js";
import { registerDefiTools } from "./tools/defi.js";
import { registerPaymentsTools } from "./tools/payments.js";
import { registerTradeTools } from "./tools/trade.js";
import { registerIntentTools } from "./tools/intent.js";
import { registerMarketTools } from "./tools/market.js";
import { registerWsTools } from "./tools/ws.js";
import { registerSkillTools } from "./tools/skills.js";
import { registerHelpTools } from "./tools/help.js";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
);

const REQUEST_TIMEOUT_MS = 30000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

const CORS_ALLOW_HEADERS = [
  "Content-Type", "Accept",
  "MCP-Protocol-Version", "Mcp-Session-Id", "Last-Event-ID",
].join(", ");

function jsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on("data", c => {
      totalSize += c.length;
      if (totalSize > MAX_BODY_BYTES) { req.destroy(); reject(new Error("Request body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      try { resolve(raw ? JSON.parse(raw) : undefined); }
      catch { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

const reqCounts = new Map<string, { count: number; resetAt: number }>();
const RATE_WINDOW_MS = 1000;
const RATE_MAX = 20;

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = reqCounts.get(ip);
  if (!entry || now > entry.resetAt) {
    reqCounts.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > RATE_MAX;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of reqCounts) if (now > v.resetAt) reqCounts.delete(k);
}, 60_000).unref();

async function main() {
  const auth = resolveAuth();
  let authValid = false;
  if (!auth) {
    logger.warn("server", "API credentials not configured — tools will return AUTH_REQUIRED",
      { fix: "Set OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE" });
  } else {
    logger.info("server", "Validating API credentials...");
    try {
      const res = await fetch("https://web3.okx.com/api/v6/dex/balance/supported-chain", {
        headers: {
          "OK-ACCESS-KEY": auth.apiKey,
          "OK-ACCESS-TIMESTAMP": new Date().toISOString(),
          "OK-ACCESS-PASSPHRASE": auth.passphrase,
        },
        signal: AbortSignal.timeout(10000),
      });
      authValid = res.ok;
    } catch { /* network error */ }
    logger.info("server", authValid ? "API credentials validated" : "API credential validation failed");
  }

  const host = process.env.HOST ?? "127.0.0.1";
  const port = parseInt(process.env.PORT ?? "3000", 10);

  // ★ Stateless mode: no session management, no Server already initialized
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,  // stateless
    enableJsonResponse: true,
  });

  const server = new McpServer({ name: "hchain-skills", version });

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

  await server.connect(transport);

  const httpServer = createServer(async (req, res) => {
    const cid = nextCorrelationId();

    const timeout = setTimeout(() => {
      if (!res.headersSent) {
        res.writeHead(408, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request timeout" }));
      }
    }, REQUEST_TIMEOUT_MS);

    try {
      const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
        ?? req.socket.remoteAddress ?? "unknown";
      if (rateLimited(ip)) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Too many requests", retryAfterMs: RATE_WINDOW_MS }));
        return;
      }

      // CORS with full MCP headers
      res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);

      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

      // Health check
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok", version,
          auth: auth ? (authValid ? "valid" : "configured_unverified") : "missing",
          tools: 117,
          mode: "stateless",
          tsIso: new Date().toISOString(),
        }));
        return;
      }

      // MCP endpoint
      if (req.url === "/mcp" || req.url?.startsWith("/mcp")) {
        try {
          let body: unknown;
          if (req.method === "POST") body = await jsonBody(req);
          await transport.handleRequest(req, res, body);
        } catch (e) {
          logger.error("http", "handleRequest failed", { error: e instanceof Error ? e.message : String(e) }, cid);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal server error" }));
          }
        }
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } finally { clearTimeout(timeout); }
  });

  httpServer.listen(port, host, () => {
    logger.info("server", "HTTP MCP Server started (stateless)", { host, port, version });
    console.error(`[hchain-skills v${version}] HTTP MCP stateless → http://${host}:${port}`);
    console.error(`[hchain-skills] Health: GET http://${host}:${port}/health`);
  });

  function shutdown(s: string) {
    logger.info("server", `Received ${s}, shutting down`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch(e => { logger.error("server", "Startup failed", { error: e instanceof Error ? e.message : String(e) }); process.exit(1); });
