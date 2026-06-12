/**
 * Diff collection, hunk parsing, commentable line-set computation, and L/R
 * annotated rendering (SPEC §4.3 line notation, §2 github/diff.ts).
 *
 * The commentable line set is the security-critical artifact: every inline
 * comment the agent submits is validated against it both at submission time
 * (tool) and immediately before publishing (Publisher).
 */
import parseDiff from "parse-diff";
import type { Octokit } from "@octokit/rest";

export type Side = "LEFT" | "RIGHT";

export interface FileDiff {
  filename: string;
  /** previous path for renames */
  previousFilename?: string;
  status: string;
  additions: number;
  deletions: number;
  /** raw unified patch for this file (may be undefined for binary files) */
  patch?: string;
  /** new-file line numbers that appear in a hunk (added + context) */
  rightLines: Set<number>;
  /** old-file line numbers that appear in a hunk (deleted + context) */
  leftLines: Set<number>;
}

export interface PrDiff {
  files: FileDiff[];
  totalAdditions: number;
  totalDeletions: number;
  /** true if any file patch was omitted (binary / too large) */
  truncated: boolean;
}

/** A position the agent may comment on, in API terms. */
export interface CommentPosition {
  path: string;
  line: number;
  side: Side;
  start_line?: number;
  start_side?: Side;
}

/**
 * Fetch the PR file list (paginated) and compute the commentable line set per
 * file. Uses listFiles patches rather than the raw `.diff` so we get GitHub's
 * own hunking, which is what the Reviews API validates against.
 */
export async function collectPrDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number,
): Promise<PrDiff> {
  const raw = await octokit.paginate(octokit.pulls.listFiles, {
    owner,
    repo,
    pull_number,
    per_page: 100,
  });

  const files: FileDiff[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;
  let truncated = false;

  for (const f of raw) {
    totalAdditions += f.additions ?? 0;
    totalDeletions += f.deletions ?? 0;

    const fd: FileDiff = {
      filename: f.filename,
      previousFilename: f.previous_filename,
      status: f.status,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      patch: f.patch,
      rightLines: new Set<number>(),
      leftLines: new Set<number>(),
    };

    if (!f.patch) {
      truncated = true;
    } else {
      indexCommentableLines(f.patch, fd);
    }
    files.push(fd);
  }

  return { files, totalAdditions, totalDeletions, truncated };
}

/** Populate rightLines/leftLines from a single-file unified patch. */
function indexCommentableLines(patch: string, fd: FileDiff): void {
  // parse-diff expects a full file diff; wrap the bare patch so it parses.
  const wrapped = `--- a/${fd.previousFilename ?? fd.filename}\n+++ b/${fd.filename}\n${patch}`;
  const parsed = parseDiff(wrapped);
  for (const file of parsed) {
    for (const chunk of file.chunks) {
      for (const change of chunk.changes) {
        if (change.type === "add") {
          fd.rightLines.add(change.ln);
        } else if (change.type === "del") {
          fd.leftLines.add(change.ln);
        } else {
          // normal/context line: present on both sides
          fd.rightLines.add(change.ln2);
          fd.leftLines.add(change.ln1);
        }
      }
    }
  }
}

/** Is a single (line, side) position commentable on this file? */
function lineCommentable(fd: FileDiff, line: number, side: Side): boolean {
  return side === "RIGHT" ? fd.rightLines.has(line) : fd.leftLines.has(line);
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

/**
 * Validate a comment position against the commentable set (SPEC §4.4, §4.5,
 * §8). Used by both the submit tool and the Publisher.
 */
export function validatePosition(diff: PrDiff, pos: CommentPosition): ValidationResult {
  const fd = diff.files.find((f) => f.filename === pos.path);
  if (!fd) return { ok: false, reason: `path not in diff: ${pos.path}` };

  if (!lineCommentable(fd, pos.line, pos.side)) {
    return {
      ok: false,
      reason: `line ${pos.side}${pos.line} of ${pos.path} is not part of the diff`,
    };
  }

  if (pos.start_line !== undefined) {
    const startSide = pos.start_side ?? pos.side;
    if (!lineCommentable(fd, pos.start_line, startSide)) {
      return {
        ok: false,
        reason: `start line ${startSide}${pos.start_line} of ${pos.path} is not part of the diff`,
      };
    }
    // GitHub requires start to precede end on the same side ordering.
    if (startSide === pos.side && pos.start_line > pos.line) {
      return { ok: false, reason: `start_line ${pos.start_line} is after line ${pos.line}` };
    }
  }

  return { ok: true };
}

/**
 * Render the PR diff with explicit L/R line numbers for the agent (SPEC §4.3).
 * Each line is prefixed with its old (`L`) and/or new (`R`) line number so the
 * agent can reference exact commentable positions.
 */
export function renderAnnotatedDiff(diff: PrDiff, maxChars: number): string {
  const blocks: string[] = [];
  let used = 0;
  let omitted = 0;

  for (const fd of diff.files) {
    const header = `\n### ${fd.filename}${
      fd.previousFilename ? ` (renamed from ${fd.previousFilename})` : ""
    } [${fd.status}, +${fd.additions} -${fd.deletions}]`;

    if (!fd.patch) {
      blocks.push(`${header}\n(no text patch available — binary or too large)`);
      continue;
    }

    const body = annotatePatch(fd);
    const block = `${header}\n\`\`\`diff\n${body}\n\`\`\``;
    if (used + block.length > maxChars) {
      omitted++;
      continue;
    }
    used += block.length;
    blocks.push(block);
  }

  let out = blocks.join("\n");
  if (omitted > 0) {
    out += `\n\n(${omitted} more file(s) omitted from diff view due to size limit)`;
  }
  return out;
}

/** Annotate one file's patch lines with L/R numbers. */
function annotatePatch(fd: FileDiff): string {
  const wrapped = `--- a/${fd.previousFilename ?? fd.filename}\n+++ b/${fd.filename}\n${fd.patch}`;
  const parsed = parseDiff(wrapped);
  const lines: string[] = [];
  for (const file of parsed) {
    for (const chunk of file.chunks) {
      lines.push(chunk.content); // @@ -a,b +c,d @@
      for (const change of chunk.changes) {
        if (change.type === "add") {
          lines.push(`R${change.ln}\t+${change.content.slice(1)}`);
        } else if (change.type === "del") {
          lines.push(`L${change.ln}\t-${change.content.slice(1)}`);
        } else {
          lines.push(`L${change.ln1} R${change.ln2}\t ${change.content.slice(1)}`);
        }
      }
    }
  }
  return lines.join("\n");
}

/** Compact per-file change stats used when the full diff is over budget. */
export function renderDiffStats(diff: PrDiff): string {
  const rows = diff.files.map(
    (f) =>
      `- ${f.filename} [${f.status}] +${f.additions} -${f.deletions}${
        f.previousFilename ? ` (from ${f.previousFilename})` : ""
      }`,
  );
  return `Changed files (${diff.files.length}), +${diff.totalAdditions} -${diff.totalDeletions}:\n${rows.join("\n")}`;
}
