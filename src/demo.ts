import * as bridge from "./tmux-bridge.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SESSION = "tmux-bridge-demo";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args, { timeout: 10_000 });
  return stdout;
}

async function tmuxNoFail(...args: string[]): Promise<void> {
  try {
    await execFileAsync("tmux", args, { timeout: 10_000 });
  } catch {
    // ignore
  }
}

export async function runDemo(): Promise<void> {
  console.log("tmux-bridge-mcp demo\n");

  // 1. Check tmux available
  try {
    await execFileAsync("tmux", ["-V"], { timeout: 5_000 });
  } catch {
    console.error("Error: tmux is not installed or not in PATH.");
    console.error("Install it with: brew install tmux (macOS) or apt install tmux (Linux)");
    process.exit(1);
  }

  console.log("Starting 3-pane demo session...\n");

  // 2. Kill leftover session
  await tmuxNoFail("kill-session", "-t", SESSION);

  // 3. Create session
  await tmux("new-session", "-d", "-s", SESSION, "-x", "200", "-y", "50");

  // 4. Split into 3 panes and label them
  // Pane 0 is created with the session
  await tmux("split-window", "-t", SESSION, "-h");
  await tmux("split-window", "-t", SESSION, "-v");

  // Get pane IDs
  const paneOutput = await tmux(
    "list-panes", "-t", SESSION, "-F", "#{pane_id}"
  );
  const paneIds = paneOutput.trim().split("\n").filter(Boolean);

  if (paneIds.length < 3) {
    console.error("Error: Failed to create 3 panes.");
    process.exit(1);
  }

  // Label panes
  await tmux("set-option", "-p", "-t", paneIds[0], "@name", "agent-1");
  await tmux("set-option", "-p", "-t", paneIds[1], "@name", "agent-2");
  await tmux("set-option", "-p", "-t", paneIds[2], "@name", "agent-3");

  // 5. Run scripted sequence
  await sleep(800);

  console.log("[Step 1/6] Reading agent-2's pane...");
  const initialContent = await bridge.read(paneIds[1], 10);
  void initialContent; // just demonstrating the read
  await sleep(800);

  console.log("[Step 2/6] Typing 'echo Hello from Agent 1' into agent-2...");
  // Mark read so type will succeed (read guard)
  bridge.markRead(paneIds[1]);
  await bridge.type(paneIds[1], "echo Hello from Agent 1");
  await sleep(800);

  console.log("[Step 3/6] Verifying text landed...");
  const afterType = await bridge.read(paneIds[1], 10);
  void afterType;
  await sleep(800);

  console.log("[Step 4/6] Pressing Enter...");
  await bridge.keys(paneIds[1], "Enter");
  await sleep(800);

  console.log("[Step 5/6] Reading result from agent-2...");
  const result = await bridge.read(paneIds[1], 10);
  void result;
  await sleep(800);

  console.log("[Step 6/6] Agent-3 reads both panes and sends summary to agent-1...");
  // Read both panes from agent-3's perspective
  const pane1Content = await bridge.read(paneIds[0], 10);
  const pane2Content = await bridge.read(paneIds[1], 10);
  void pane1Content;
  void pane2Content;
  // Type a summary into agent-1
  bridge.markRead(paneIds[0]);
  await bridge.type(paneIds[0], "echo 'Summary: agent-2 executed Hello command successfully'");
  await bridge.read(paneIds[0], 10);
  await bridge.keys(paneIds[0], "Enter");
  await sleep(800);

  console.log("\nDemo complete!");
  console.log(`  Session: ${SESSION} (3 panes: agent-1, agent-2, agent-3)`);
  console.log(`  Attach: tmux attach -t ${SESSION}`);
  console.log(`  Clean up: tmux kill-session -t ${SESSION}`);
}
