/**
 * hchain-skills Server — HTTP 传输层 (stateless, per-request)
 * MCP Streamable HTTP Protocol — official stateless pattern
 * v1.6.1: per-request McpServer + StreamableHTTPServerTransport
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { resolveAuth } from "./adapters/shared.js";
import { logger } from "./adapters/logger.js";
import { registerAllTools } from "./tools/all.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));

const REQUEST_TIMEOUT_MS = 30000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const CORS_ORIGIN = (process.env.CORS_ORIGIN || "").trim();
const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = parseInt(process.env.PORT ?? "3000", 10);

const MCP_HEADERS = "Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID";

let totalToolsRegistered = 0;

function createConfiguredMcpServer(auth: ReturnType<typeof resolveAuth>): McpServer {
  const server = new McpServer({ name: "hchain-skills", version });
  registerAllTools(server, auth);
  return server;
}

function jsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on("data", c => {
      totalSize += c.length;
      if (totalSize > MAX_BODY_BYTES) { req.destroy(); reject(new Error("body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      try { resolve(raw ? JSON.parse(raw) : undefined); }
      catch { reject(new Error("invalid JSON")); }
    });
    req.on("error", reject);
  });
}

// Rate limiter
const reqCounts = new Map<string, { count: number; resetAt: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = reqCounts.get(ip);
  if (!entry || now > entry.resetAt) { reqCounts.set(ip, { count: 1, resetAt: now + 1000 }); return false; }
  entry.count++;
  return entry.count > 20;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of reqCounts) if (now > v.resetAt) reqCounts.delete(k); }, 60000).unref();

// JSON-RPC error helper
function jsonRpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: id ?? null });
}

async function main() {
  const auth = resolveAuth();
  let authValid = false;

  if (!auth) {
    logger.warn("server", "API credentials not configured — tools will return AUTH_REQUIRED");
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
    } catch { /* network error — tools still work */ }
    logger.info("server", authValid ? "API credentials validated" : "API credential validation failed");
  }

  // Tool count: use hardcoded until we can count at runtime
  totalToolsRegistered = 117; // All 11 registrars

  logger.info("server", `MCP Stateless HTTP starting`, { tools: totalToolsRegistered });

  const httpServer = createServer(async (req, res) => {
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
        res.end(JSON.stringify({ error: "Too many requests", retryAfterMs: 1000 }));
        return;
      }

      // CORS
      if (CORS_ORIGIN) {
        res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
      }
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", MCP_HEADERS);
      res.setHeader("Access-Control-Expose-Headers", MCP_HEADERS);

      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

      // Health check
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok", version,
          auth: auth ? (authValid ? "valid" : "configured_unverified") : "missing",
          tools: totalToolsRegistered,
          mode: "stateless",
          tsIso: new Date().toISOString(),
        }));
        return;
      }

      // MCP endpoint
      if (req.url === "/mcp" || req.url?.startsWith("/mcp")) {
        const method = req.method?.toUpperCase() ?? "POST";

        // Stateless: only POST is accepted
        if (method === "GET") {
          res.writeHead(405, { "Allow": "POST", "Content-Type": "application/json" });
          res.end(jsonRpcError(null, -32000, "Method Not Allowed: use POST"));
          return;
        }
        if (method === "DELETE") {
          res.writeHead(405, { "Allow": "POST", "Content-Type": "application/json" });
          res.end(jsonRpcError(null, -32000, "Method Not Allowed: stateless mode, no sessions to delete"));
          return;
        }
        if (method !== "POST") {
          res.writeHead(405, { "Allow": "POST", "Content-Type": "application/json" });
          res.end(jsonRpcError(null, -32000, "Method Not Allowed"));
          return;
        }

        let body: unknown;
        try { body = await jsonBody(req); }
        catch (e: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(jsonRpcError(null, -32700, "Parse error: " + e.message));
          return;
        }

        // ★ Per-request server + transport
        const perReqServer = createConfiguredMcpServer(auth);
        const perReqTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });

        try {
          await perReqServer.connect(perReqTransport);
          await perReqTransport.handleRequest(req, res, body);
        } catch (e) {
          logger.error("http", "handleRequest failed", { error: e instanceof Error ? e.message : String(e) });
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(jsonRpcError(null, -32603, "Internal error"));
          }
        } finally {
          try { await perReqTransport.close(); } catch {}
        }
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(jsonRpcError(null, -32601, "Not found"));
    } finally { clearTimeout(timeout); }
  });

  httpServer.listen(PORT, HOST, () => {
    logger.info("server", `MCP Stateless HTTP started`, { host: HOST, port: PORT, version });
    console.error(`[hchain-skills v${version}] MCP stateless HTTP → http://${HOST}:${PORT}`);
    console.error(`[hchain-skills] Health: GET http://${HOST}:${PORT}/health`);
    console.error(`[hchain-skills] Tools: ${totalToolsRegistered}`);
  });

  function shutdown(s: string) {
    logger.info("server", `Shutting down: ${s}`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch(e => { logger.error("server", "Startup failed", { error: String(e) }); process.exit(1); });
