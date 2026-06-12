/**
 * Minimal .env loader (no dependency). Populates process.env from a .env file
 * in the working directory if present; existing env vars take precedence.
 */
import { readFileSync } from "node:fs";

export function loadDotenv(path = ".env"): void {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return; // no .env — rely on the real environment
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key in process.env) continue; // don't override real env
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes; preserve inner content (incl. escaped newlines).
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
