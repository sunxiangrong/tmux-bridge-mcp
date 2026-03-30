#!/usr/bin/env node
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const HELP = `tmux-bridge-mcp v${pkg.version} — MCP server for cross-pane AI agent communication

Usage:
  npx tmux-bridge-mcp           Start MCP server (stdio)
  npx tmux-bridge-mcp setup     Auto-configure installed agents
  npx tmux-bridge-mcp demo      Run a live 3-pane demo in tmux

Options:
  --help, -h     Show this help
  --version, -V  Show version
`;

async function main() {
  const arg = process.argv[2];

  // No args + piped stdin → MCP server
  if (!arg && !process.stdin.isTTY) {
    const { startServer } = await import("./index.js");
    await startServer();
    return;
  }

  switch (arg) {
    case "setup": {
      const { runSetup } = await import("./setup.js");
      await runSetup();
      break;
    }
    case "demo": {
      const { runDemo } = await import("./demo.js");
      await runDemo();
      break;
    }
    case "--version":
    case "-V":
      console.log(pkg.version);
      break;
    case "--help":
    case "-h":
    default:
      process.stdout.write(HELP);
      break;
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
