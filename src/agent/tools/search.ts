/**
 * search tool (SPEC §3.5: grep/symbol search to track callers and usages of
 * changed functions). Implemented as a confined recursive scan so it needs no
 * external `rg` binary and cannot run arbitrary processes (§8 tool whitelist).
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { confinePath, textResult } from "./util.js";

const Params = Type.Object({
  query: Type.String({ description: "Text or regular expression to search for." }),
  regex: Type.Optional(
    Type.Boolean({ description: "Treat query as a regular expression (default false)." }),
  ),
  path: Type.Optional(
    Type.String({ description: "Repo-relative subdirectory to limit the search to." }),
  ),
  max_results: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 200, description: "Max matching lines (default 50)." }),
  ),
});

const IGNORE_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "vendor", "target"]);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SCANNED_FILES = 5000;
const NUL = String.fromCharCode(0);

function looksBinary(buf: string): boolean {
  // A NUL byte in the first chunk is a reliable binary-file signal.
  return buf.slice(0, 8192).includes(NUL);
}

export function createSearchTool(root: string): AgentTool<typeof Params> {
  return {
    name: "search",
    label: "Search code",
    description:
      "Search file contents across the PR checkout (literal or regex). Returns matching lines as path:line: content. Use to find callers, usages, and definitions of changed symbols.",
    parameters: Params,
    execute: async (_id, params: Static<typeof Params>, signal?: AbortSignal) => {
      const startDir = params.path ? confinePath(root, params.path) : root;
      const limit = params.max_results ?? 50;

      let matcher: (line: string) => boolean;
      if (params.regex) {
        let re: RegExp;
        try {
          re = new RegExp(params.query, "i");
        } catch (e) {
          throw new Error(`invalid regex: ${String(e)}`);
        }
        matcher = (line) => re.test(line);
      } else {
        const needle = params.query.toLowerCase();
        matcher = (line) => line.toLowerCase().includes(needle);
      }

      const results: string[] = [];
      let scanned = 0;

      const walk = async (dir: string): Promise<void> => {
        if (results.length >= limit || scanned >= MAX_SCANNED_FILES) return;
        if (signal?.aborted) throw new Error("aborted");
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (results.length >= limit || scanned >= MAX_SCANNED_FILES) return;
          const abs = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (IGNORE_DIRS.has(entry.name)) continue;
            await walk(abs);
          } else if (entry.isFile()) {
            const info = await stat(abs).catch(() => null);
            if (!info || info.size > MAX_FILE_BYTES) continue;
            scanned++;
            const content = await readFile(abs, "utf8").catch(() => "");
            if (!content || looksBinary(content)) continue;
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (matcher(lines[i])) {
                const rel = relative(root, abs).replace(/\\/g, "/");
                results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
                if (results.length >= limit) return;
              }
            }
          }
        }
      };

      await walk(startDir);

      const header =
        results.length === 0
          ? `No matches for "${params.query}".`
          : `${results.length} match(es)${results.length >= limit ? " (capped)" : ""}:`;
      return textResult(`${header}\n${results.join("\n")}`, { matches: results.length });
    },
  };
}
