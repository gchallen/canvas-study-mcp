import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CanvasClient } from "./canvas.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { ReviewStore } from "./store.js";

const config = loadConfig();
const canvas = config.baseUrl && config.token ? new CanvasClient(config.baseUrl, config.token) : null;
const store = new ReviewStore(join(config.dataDir, "reviews.json"));

// stdout carries the MCP protocol, so diagnostics go to stderr.
if (config.problem) console.error(`canvas-study-mcp: ${config.problem}`);

const server = createServer({ canvas, canvasProblem: config.problem, store });
await server.connect(new StdioServerTransport());
