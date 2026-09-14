#!/usr/bin/env node

import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import {createServer} from "./server.js";
import {logger, logOutgoingMessages} from "./logger.js";

// check envs
const REQUIRED_ENV = ["SUBSTACK_PUBLICATION_URL", "SUBSTACK_SESSION_TOKEN", "SUBSTACK_USER_ID"];
const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]);

if (missingEnv.length > 0) {
  // Which variable is missing is the whole diagnosis, and the thrown message cannot say —
  // clients surface it verbatim and its wording is pinned by the tests.
  logger.error("server.env.missing", {missing: missingEnv});
  throw new Error("SUBSTACK_PUBLICATION_URL, SUBSTACK_SESSION_TOKEN and SUBSTACK_USER_ID must be set");
}

// Optional allowlist for exposed tools: a comma-separated list of tool names. Unset (the
// default) registers every tool, exactly as before this fork added remote/HTTP support —
// stdio/local users are unaffected. A remote deployment should set this to a narrow,
// low-risk subset, since the token behind SUBSTACK_SESSION_TOKEN has full account access
// and this server's whole tool surface would otherwise sit behind one shared secret.
const allowedToolsEnv = process.env.SUBSTACK_MCP_ALLOWED_TOOLS;
const allowedTools = allowedToolsEnv
  ? new Set(
    allowedToolsEnv
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
  )
  : undefined;

const transportMode = process.env.TRANSPORT || "stdio";

logger.info("server.starting", {
  publication_url: process.env.SUBSTACK_PUBLICATION_URL,
  user_id: process.env.SUBSTACK_USER_ID,
  log_level: process.env.SUBSTACK_MCP_LOG_LEVEL || "info",
  node: process.version,
  transport: transportMode,
  allowed_tools: allowedTools ? [...allowedTools] : "all",
});

async function runStdio() {
  const server = createServer({allowedTools});
  const transport = logOutgoingMessages(new StdioServerTransport());
  await server.connect(transport);
  logger.info("server.ready", {transport: "stdio"});
}

/**
 * Constant-time-ish bearer token check. SUBSTACK_SESSION_TOKEN gives this server full
 * control of your Substack account — treat it like your account password, not like an
 * ordinary API key. The /mcp endpoint MUST NOT be left open on a public URL without a
 * shared secret. Set MCP_SERVER_TOKEN here and configure the same value in your MCP
 * client's Authorization header.
 */
function authMiddleware(req, res, next) {
  const expected = process.env.MCP_SERVER_TOKEN;
  if (!expected) {
    // No token configured: allow, but this was already warned about at boot.
    next();
    return;
  }
  const header = req.header("authorization") || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (provided !== expected) {
    res.status(401).json({error: "unauthorized"});
    return;
  }
  next();
}

async function runHTTP() {
  if (!process.env.MCP_SERVER_TOKEN) {
    logger.error("server.mcp_server_token.missing", {
      warning:
        "MCP_SERVER_TOKEN is not set. The /mcp endpoint will be reachable by anyone who finds " +
        "the URL, with full access to this Substack account. Set MCP_SERVER_TOKEN before " +
        "deploying publicly.",
    });
  }

  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.status(200).json({status: "ok"});
  });

  app.post("/mcp", authMiddleware, async (req, res) => {
    try {
      // Stateless: a fresh server + transport per request avoids request-id collisions
      // across concurrent clients and keeps deployment simple — mirrors the pattern used
      // in jackyckma/cursoragentmcp.
      const server = createServer({allowedTools});
      const transport = logOutgoingMessages(
        new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        })
      );
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error("server.mcp_request.failed", {error});
      if (!res.headersSent) {
        res.status(500).json({error: "internal_error"});
      }
    }
  });

  const port = parseInt(process.env.PORT || "3000", 10);
  app.listen(port, () => {
    logger.info("server.ready", {transport: "http", port});
  });
}

if (transportMode === "http") {
  runHTTP().catch((error) => {
    logger.error("server.connect.failed", {error});
    process.exit(1);
  });
} else {
  runStdio().catch((error) => {
    logger.error("server.connect.failed", {error});
    process.exit(1);
  });
}
