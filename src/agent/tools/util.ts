/**
 * Shared helpers for read-only agent tools. Every tool confines filesystem
 * access to the checkout root (SPEC §4.4: "reject paths outside checkout
 * directory — path normalization + root confinement").
 */
import { resolve, relative, isAbsolute, sep } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

/** Resolve a user-supplied path against the root, rejecting any escape. */
export function confinePath(root: string, userPath: string): string {
  const absRoot = resolve(root);
  const candidate = isAbsolute(userPath) ? resolve(userPath) : resolve(absRoot, userPath);
  const rel = relative(absRoot, candidate);
  if (rel === "" ) return absRoot;
  if (rel.startsWith("..") || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`path escapes checkout root: ${userPath}`);
  }
  return candidate;
}

/** Build a plain text tool result. */
export function textResult<T = unknown>(text: string, details?: T): AgentToolResult<T> {
  return { content: [{ type: "text", text }], details: details as T };
}
