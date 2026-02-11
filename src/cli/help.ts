export function formatHelp(): string {
  return [
    "pi-team",
    "",
    "Usage: pi-team <command> [options]",
    "",
    "Commands:",
    "  daemon start --team <id> [--workspace-root <path>] [--json]",
    "  daemon status --team <id> [--workspace-root <path>] [--json]",
    "  team create <teamId> --leader <agentId> [--workspace-root <path>] [--json]",
    "  tasks list --team <teamId> [--workspace-root <path>] [--json]",
    "  threads list|tail|show --team <teamId> [--workspace-root <path>] [--json]",
    "  agent env --team <id> --agent <agentId> [--workspace-root <path>]",
    "",
    "Options:",
    "  -h, --help    Show help",
  ].join("\n");
}
