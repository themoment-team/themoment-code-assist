/**
 * read_file tool (SPEC §3.5 toolset, §2 agent/tools/read_file.ts).
 * Reads file content from the checkout, optionally within a line range.
 */
import { readFile, stat } from "node:fs/promises";
import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { confinePath, textResult } from "./util.js";

const Params = Type.Object({
  path: Type.String({ description: "Repo-relative path to the file to read." }),
  start_line: Type.Optional(
    Type.Integer({ minimum: 1, description: "1-based first line (inclusive)." }),
  ),
  end_line: Type.Optional(
    Type.Integer({ minimum: 1, description: "1-based last line (inclusive)." }),
  ),
});

const MAX_BYTES = 512 * 1024;
const MAX_LINES = 800;

export function createReadFileTool(root: string): AgentTool<typeof Params> {
  return {
    name: "read_file",
    label: "Read file",
    description:
      "Read a file's contents from the PR checkout. Optionally restrict to a 1-based line range. Returns lines prefixed with their line numbers.",
    parameters: Params,
    execute: async (_id, params: Static<typeof Params>) => {
      const abs = confinePath(root, params.path);
      const info = await stat(abs).catch(() => null);
      if (!info || !info.isFile()) {
        throw new Error(`not a file: ${params.path}`);
      }
      if (info.size > MAX_BYTES) {
        throw new Error(
          `file too large (${info.size} bytes); read a line range instead`,
        );
      }
      const content = await readFile(abs, "utf8");
      const allLines = content.split("\n");

      const start = params.start_line ?? 1;
      const end = params.end_line ?? allLines.length;
      if (start > end) throw new Error("start_line must be <= end_line");

      const slice = allLines.slice(start - 1, Math.min(end, start - 1 + MAX_LINES));
      const numbered = slice.map((l, i) => `${start + i}\t${l}`).join("\n");
      const truncatedNote =
        end - start + 1 > MAX_LINES ? `\n... (truncated at ${MAX_LINES} lines)` : "";

      return textResult(
        `${params.path} (lines ${start}-${start + slice.length - 1} of ${allLines.length}):\n${numbered}${truncatedNote}`,
        { path: params.path, lines: slice.length },
      );
    },
  };
}
