/**
 * git_blame tool (SPEC §3.5: query history of changed lines to understand why
 * code was written that way). Wraps `git blame` on the checkout — a fixed,
 * read-only command, not general bash (§8 tool whitelist).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { confinePath, textResult } from "./util.js";

const exec = promisify(execFile);

const Params = Type.Object({
  path: Type.String({ description: "Repo-relative path to blame." }),
  start_line: Type.Integer({ minimum: 1, description: "1-based first line." }),
  end_line: Type.Integer({ minimum: 1, description: "1-based last line." }),
});

const MAX_RANGE = 200;

export function createGitBlameTool(root: string): AgentTool<typeof Params> {
  return {
    name: "git_blame",
    label: "Git blame",
    description:
      "Show the commit, author, date, and summary responsible for each line in a range. Use to understand the intent and history behind changed code.",
    parameters: Params,
    execute: async (_id, params: Static<typeof Params>, signal?: AbortSignal) => {
      // Confine the path even though blame runs inside the checkout cwd.
      confinePath(root, params.path);
      if (params.end_line < params.start_line) {
        throw new Error("end_line must be >= start_line");
      }
      const end = Math.min(params.end_line, params.start_line + MAX_RANGE - 1);

      let stdout: string;
      try {
        ({ stdout } = await exec(
          "git",
          [
            "blame",
            "--porcelain",
            "-L",
            `${params.start_line},${end}`,
            "--",
            params.path,
          ],
          { cwd: root, signal, maxBuffer: 16 * 1024 * 1024 },
        ));
      } catch (e) {
        throw new Error(`git blame failed: ${(e as Error).message}`);
      }

      return textResult(formatPorcelain(stdout, params.start_line), {
        path: params.path,
        range: [params.start_line, end],
      });
    },
  };
}

/** Condense porcelain blame into one readable line per source line. */
function formatPorcelain(porcelain: string, startLine: number): string {
  const lines = porcelain.split("\n");
  const commits = new Map<string, { author?: string; time?: string; summary?: string }>();
  const out: string[] = [];
  let current: string | null = null;
  let lineNo = startLine;

  for (const l of lines) {
    const header = /^([0-9a-f]{40})\s+\d+\s+\d+/.exec(l);
    if (header) {
      current = header[1];
      if (!commits.has(current)) commits.set(current, {});
      continue;
    }
    if (current) {
      const meta = commits.get(current)!;
      if (l.startsWith("author ")) meta.author = l.slice(7);
      else if (l.startsWith("author-time ")) {
        meta.time = new Date(Number(l.slice(12)) * 1000).toISOString().slice(0, 10);
      } else if (l.startsWith("summary ")) meta.summary = l.slice(8);
      else if (l.startsWith("\t")) {
        const meta2 = commits.get(current)!;
        out.push(
          `${lineNo}\t${current.slice(0, 8)} ${meta2.author ?? "?"} ${meta2.time ?? ""}\t${meta2.summary ?? ""}`,
        );
        lineNo++;
      }
    }
  }
  return out.join("\n") || "(no blame output)";
}
