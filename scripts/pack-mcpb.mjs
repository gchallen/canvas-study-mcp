// Assembles build/mcpb (manifest + bundled server) and packs it into canvas-study.mcpb.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const stage = join(root, "build", "mcpb");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "server"), { recursive: true });

// package.json is the source of truth for the version.
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
manifest.version = version;

// Test builds only: --test-insecure-tls turns off certificate checking so the server can reach a
// local Canvas behind an mkcert certificate. Claude Desktop does not pass its environment on to
// extensions, and its built-in Node ignores NODE_EXTRA_CA_CERTS, so this has to be in the manifest.
// The output is named so it cannot be mistaken for the real bundle. Never ship it.
const testBuild = process.argv.includes("--test-insecure-tls");
if (testBuild) manifest.server.mcp_config.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const output = join(root, testBuild ? "canvas-study-test.mcpb" : "canvas-study.mcpb");

writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2));
copyFileSync(join(root, "dist", "index.js"), join(stage, "server", "index.js"));

const mcpb = join(root, "node_modules", ".bin", "mcpb");
execFileSync(mcpb, ["validate", join(stage, "manifest.json")], { stdio: "inherit" });
execFileSync(mcpb, ["pack", stage, output], { stdio: "inherit" });
