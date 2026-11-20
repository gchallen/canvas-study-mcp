import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  /** Canvas origin, such as https://canvas.illinois.edu. Undefined when not configured. */
  baseUrl?: string;
  token?: string;
  dataDir: string;
  /** Why Canvas is unavailable, when it is. */
  problem?: string;
}

/** Accepts "canvas.school.edu", a full URL, or a URL with a path, and returns the https origin. */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  if (url.protocol !== "https:") {
    throw new Error("The Canvas URL must use https, so the access token is never sent unencrypted.");
  }
  return url.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env.CANVAS_STUDY_DATA_DIR?.trim() || join(homedir(), ".canvas-study-mcp");
  const rawUrl = env.CANVAS_BASE_URL?.trim();
  const token = env.CANVAS_API_TOKEN?.trim();

  if (!rawUrl || !token) {
    const missing = [!rawUrl && "CANVAS_BASE_URL", !token && "CANVAS_API_TOKEN"].filter(Boolean);
    const verb = missing.length > 1 ? "are" : "is";
    return { dataDir, problem: `Canvas is not configured: ${missing.join(" and ")} ${verb} not set.` };
  }
  try {
    return { baseUrl: normalizeBaseUrl(rawUrl), token, dataDir };
  } catch (error) {
    return { dataDir, problem: `CANVAS_BASE_URL is not usable: ${(error as Error).message}` };
  }
}
