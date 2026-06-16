/**
 * .env loader via dotenv. Populates process.env from a .env file in the
 * working directory if present; existing env vars take precedence (override: false).
 */
import { configDotenv } from "dotenv";

export function loadDotenv(path = ".env"): void {
  configDotenv({ path, override: false });
}
