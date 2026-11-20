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
writeFileSync(join(stage, "manifest.json"), JSON.stringify({ ...manifest, version }, null, 2));
copyFileSync(join(root, "dist", "index.js"), join(stage, "server", "index.js"));

const mcpb = join(root, "node_modules", ".bin", "mcpb");
execFileSync(mcpb, ["validate", join(stage, "manifest.json")], { stdio: "inherit" });
execFileSync(mcpb, ["pack", stage, join(root, "canvas-study.mcpb")], { stdio: "inherit" });
