#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import dotenv from "dotenv";
import { JiraClient } from "./jira-client.js";
import { createServer } from "./server.js";

dotenv.config();

const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const PAT = process.env.PAT;

if (!JIRA_BASE_URL || !PAT) {
  console.error("Missing required environment variables: JIRA_BASE_URL and PAT");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
  homepage?: string;
  bugs?: { url?: string };
};

const client = new JiraClient({
  baseUrl: JIRA_BASE_URL,
  pat: PAT,
  requestTimeoutMs: process.env.JIRA_REQUEST_TIMEOUT_MS ? Number(process.env.JIRA_REQUEST_TIMEOUT_MS) : undefined,
});

// One server instance is pinned per connection; the same factory serves both the 2025 and 2026-07-28 protocol eras.
serveStdio(
  () =>
    createServer({
      client,
      version: pkg.version,
      baseUrl: JIRA_BASE_URL,
      bugsUrl: pkg.bugs?.url ?? "https://github.com/yogeshhrathod/jiraMCP/issues",
      homepage: pkg.homepage,
    }),
  { onerror: (error) => console.error(`[jira-mcp] ${error.message}`) }
);

console.error(`Jira MCP Server ${pkg.version} running on stdio`);
