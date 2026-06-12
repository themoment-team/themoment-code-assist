/**
 * Command parsing & permission gate (SPEC §4.7, D8).
 *
 * Commands are exact matches on a standalone line. Only users with write access
 * or above (author_association OWNER/MEMBER/COLLABORATOR) may trigger them, to
 * prevent cost-inducing triggers from external contributors.
 */
export type Command = "review" | "reply-review";

const COMMAND_TOKENS: Record<string, Command> = {
  "/review": "review",
  "/reply-review": "reply-review",
};

const ALLOWED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** Detect a command appearing as a standalone line in a comment body. */
export function detectCommand(body: string | null | undefined): Command | undefined {
  if (!body) return undefined;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    const cmd = COMMAND_TOKENS[line];
    if (cmd) return cmd;
  }
  return undefined;
}

/** True if the comment author has write access or above. */
export function hasPermission(authorAssociation: string | undefined): boolean {
  return !!authorAssociation && ALLOWED_ASSOCIATIONS.has(authorAssociation);
}
