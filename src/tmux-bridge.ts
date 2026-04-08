/**
 * tmux-bridge core — direct tmux interaction via child_process.
 * No external CLI dependencies (no smux, no tmux-bridge CLI).
 * Only requires `tmux` to be installed.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

export type PaneKind = "agent" | "ssh-shell" | "manual" | "unknown";

// --- Read Guard ---
// Enforces read-before-act: agents must read a pane before typing/keys.

const readGuardDir = join(tmpdir(), "tmux-bridge-guards");

function guardPath(paneId: string): string {
  return join(readGuardDir, paneId.replace(/%/g, "_"));
}

export function markRead(paneId: string): void {
  try {
    if (!existsSync(readGuardDir)) {
      mkdirSync(readGuardDir, { recursive: true });
    }
    writeFileSync(guardPath(paneId), "", { flag: "w" });
  } catch {
    // Best-effort
  }
}

export function requireRead(paneId: string): void {
  if (!existsSync(guardPath(paneId))) {
    throw new Error(
      `Must read pane ${paneId} before interacting. Call tmux_read first.`
    );
  }
}

export function clearRead(paneId: string): void {
  try {
    unlinkSync(guardPath(paneId));
  } catch {
    // Already cleared
  }
}

// --- tmux socket detection ---

function detectSocketArgs(): string[] {
  const override = process.env.TMUX_BRIDGE_SOCKET;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`TMUX_BRIDGE_SOCKET=${override} is not a valid socket`);
    }
    return ["-S", override];
  }

  const tmuxEnv = process.env.TMUX;
  if (tmuxEnv) {
    const socket = tmuxEnv.split(",")[0];
    if (socket && existsSync(socket)) {
      return ["-S", socket];
    }
  }

  // Default tmux server
  return [];
}

async function tmux(...args: string[]): Promise<string> {
  const socketArgs = detectSocketArgs();
  const { stdout } = await execFileAsync("tmux", [...socketArgs, ...args], {
    timeout: 10_000,
    env: { ...process.env },
  });
  return stdout;
}

async function tmuxNoFail(...args: string[]): Promise<string> {
  try {
    return await tmux(...args);
  } catch {
    return "";
  }
}

// --- Target Resolution ---
// Supports: pane ID (%N), session:win.pane, label (@name), or pure number (window index)

async function resolveTarget(target: string): Promise<string> {
  // tmux pane ID like %0, %12
  if (/^%\d+$/.test(target)) return target;

  // canonical session:window or session:window.pane
  if (/^[^:\s]+:\d+(?:\.\d+)?$/.test(target)) return target;

  // Pure numeric — treat as window index
  if (/^\d+$/.test(target)) return target;

  // Otherwise resolve as @name label
  const output = await tmux(
    "list-panes",
    "-a",
    "-F",
    "#{pane_id} #{@name}"
  );
  for (const line of output.trim().split("\n")) {
    const [paneId, ...labelParts] = line.split(" ");
    const label = labelParts.join(" ");
    if (label === target) return paneId;
  }
  throw new Error(`No pane found with label '${target}'`);
}

async function validateTarget(target: string): Promise<void> {
  try {
    await tmux("display-message", "-t", target, "-p", "#{pane_id}");
  } catch {
    throw new Error(`Invalid target: ${target}`);
  }
}

async function getPaneId(target: string): Promise<string> {
  const output = await tmux(
    "display-message",
    "-t",
    target,
    "-p",
    "#{pane_id}"
  );
  return output.trim();
}

// --- Loop Prevention ---

function assertNotSelf(paneId: string, action: string): void {
  const self = process.env.TMUX_PANE;
  if (self && paneId === self) {
    if (action === "message") {
      throw new Error("Cannot send message to your own pane (loop prevention)");
    }
    throw new Error("Cannot interact with your own pane");
  }
}

// --- Public API ---

export interface PaneInfo {
  target: string;
  sessionWindow: string;
  size: string;
  process: string;
  label: string;
  cwd: string;
  kind: PaneKind;
}

export async function list(): Promise<PaneInfo[]> {
  const output = await tmux(
    "list-panes",
    "-a",
    "-F",
    "#{pane_id}|#{session_name}:#{window_index}|#{pane_width}x#{pane_height}|#{pane_current_command}|#{@name}|#{pane_current_path}"
  );

  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [target, sessionWindow, size, cmd, label, cwd] =
        line.split("|");
      const home = process.env.HOME || "";
      return {
        target,
        sessionWindow,
        size,
        process: cmd || "?",
        label: label || "",
        cwd: home && cwd ? cwd.replace(home, "~") : (cwd || ""),
        kind: classifyPane({
          label: label || "",
          process: cmd || "",
          cwd: cwd || "",
        }),
      };
    });
}

export async function read(target: string, lines: number = 50): Promise<string> {
  const resolved = await resolveTarget(target);
  await validateTarget(resolved);
  const paneId = await getPaneId(resolved);
  await assertReadableTarget(resolved, paneId);

  const output = await tmux(
    "capture-pane",
    "-t",
    resolved,
    "-p",
    "-J",
    "-S",
    `-${lines}`
  );

  markRead(paneId);
  return output;
}

export async function type(target: string, text: string): Promise<void> {
  const resolved = await resolveTarget(target);
  await validateTarget(resolved);
  const paneId = await getPaneId(resolved);
  assertNotSelf(paneId, "type");
  requireRead(paneId);
  await assertWritableTarget(resolved, paneId);
  await assertPaneInputAllowed(resolved, text);

  await tmux("send-keys", "-t", resolved, "-l", "--", text);
  clearRead(paneId);
}

export async function message(
  target: string,
  text: string
): Promise<void> {
  const resolved = await resolveTarget(target);
  await validateTarget(resolved);
  const paneId = await getPaneId(resolved);
  assertNotSelf(paneId, "message");
  requireRead(paneId);
  await assertWritableTarget(resolved, paneId);

  // Detect sender identity
  const senderPane = process.env.TMUX_PANE || "unknown";
  const senderLabel = await tmuxNoFail(
    "display-message",
    "-t",
    senderPane,
    "-p",
    "#{@name}"
  );
  const from = senderLabel.trim() || senderPane;

  const correlationId = randomUUID().slice(0, 8);
  const header = `[tmux-bridge from:${from} pane:${senderPane} id:${correlationId}]`;
  await tmux("send-keys", "-t", resolved, "-l", "--", `${header} ${text}`);
  clearRead(paneId);
}

export async function keys(
  target: string,
  ...keyList: string[]
): Promise<void> {
  const resolved = await resolveTarget(target);
  await validateTarget(resolved);
  const paneId = await getPaneId(resolved);
  assertNotSelf(paneId, "keys");
  requireRead(paneId);
  await assertWritableTarget(resolved, paneId);

  for (const key of keyList) {
    await tmux("send-keys", "-t", resolved, key);
  }
  clearRead(paneId);
}

export async function name(target: string, label: string): Promise<void> {
  const resolved = await resolveTarget(target);
  await validateTarget(resolved);
  await tmux("set-option", "-p", "-t", resolved, "@name", label);
}

export async function resolve(label: string): Promise<string> {
  const output = await tmux(
    "list-panes",
    "-a",
    "-F",
    "#{pane_id} #{@name}"
  );
  for (const line of output.trim().split("\n")) {
    const [paneId, ...labelParts] = line.split(" ");
    if (labelParts.join(" ") === label) return paneId;
  }
  throw new Error(`No pane found with label '${label}'`);
}

export async function id(): Promise<string> {
  const pane = process.env.TMUX_PANE;
  if (!pane) throw new Error("Not running inside a tmux pane ($TMUX_PANE is unset)");
  return pane;
}

// --- Sensible Defaults ---
// Applied at startup so tmux feels like a normal terminal out of the box.
// Uses runtime set-option (no file writes), safe to call multiple times.

export async function applyDefaults(): Promise<string[]> {
  const applied: string[] = [];

  const defaults: Array<[string[], string]> = [
    // Mouse scroll, click, and drag — feels like a normal terminal
    [["set-option", "-g", "mouse", "on"], "mouse on"],
    // Long scrollback so conversation history isn't lost
    [["set-option", "-g", "history-limit", "100000"], "history-limit 100000"],
    // Vi keys in copy mode for efficient scrolling (k/j, Ctrl-u/d, g/G)
    [["set-option", "-g", "mode-keys", "vi"], "mode-keys vi"],
  ];

  for (const [args, label] of defaults) {
    try {
      await tmux(...args);
      applied.push(label);
    } catch {
      // Non-fatal — keep going
    }
  }

  return applied;
}

export async function doctor(): Promise<string> {
  const lines: string[] = ["tmux-bridge doctor", "---"];
  let hasErrors = false;

  lines.push(`TMUX_PANE:          ${process.env.TMUX_PANE || "<unset>"}`);
  lines.push(`TMUX:               ${process.env.TMUX || "<unset>"}`);
  lines.push(
    `TMUX_BRIDGE_SOCKET: ${process.env.TMUX_BRIDGE_SOCKET || "<unset>"}`
  );

  // Check tmux binary
  try {
    const ver = await tmux("-V");
    lines.push(`tmux version:       ${ver.trim()}`);
  } catch {
    lines.push(`tmux:               NOT FOUND`);
    lines.push("---");
    lines.push("Status: FAILED — tmux is not installed");
    return lines.join("\n");
  }

  // Socket detection
  lines.push("---");
  try {
    const socketArgs = detectSocketArgs();
    lines.push(
      `Socket:             ${socketArgs.length ? socketArgs[1] : "(default)"}`
    );
  } catch (e) {
    hasErrors = true;
    lines.push(`Socket:             FAILED — ${(e as Error).message}`);
  }

  // Pane count
  try {
    const output = await tmux("list-panes", "-a", "-F", "#{pane_id}");
    const count = output.trim().split("\n").filter(Boolean).length;
    lines.push(`Total panes:        ${count}`);

    const labeled = await tmux("list-panes", "-a", "-F", "#{@name}");
    const labeledCount = labeled
      .trim()
      .split("\n")
      .filter((l) => l.trim()).length;
    lines.push(`Labeled panes:      ${labeledCount}`);
  } catch {
    hasErrors = true;
    lines.push(`Panes:              unable to list`);
  }

  // Current pane visibility
  const pane = process.env.TMUX_PANE;
  if (pane) {
    try {
      await tmux("display-message", "-t", pane, "-p", "#{pane_id}");
      lines.push(`This pane (${pane}):  visible to server`);
    } catch {
      hasErrors = true;
      lines.push(`This pane (${pane}):  NOT visible to server`);
    }
  }

  // Show applied defaults
  lines.push("---");
  try {
    const mouse = (await tmuxNoFail("show-option", "-gv", "mouse")).trim();
    const histLimit = (await tmuxNoFail("show-option", "-gv", "history-limit")).trim();
    const modeKeys = (await tmuxNoFail("show-option", "-gv", "mode-keys")).trim();
    lines.push(`mouse:              ${mouse || "?"}`);
    lines.push(`history-limit:      ${histLimit || "?"}`);
    lines.push(`mode-keys:          ${modeKeys || "?"}`);
  } catch {
    lines.push(`Defaults:           unable to query`);
  }

  lines.push("---");
  lines.push(hasErrors ? "Status: DEGRADED — some checks failed" : "Status: OK");
  return lines.join("\n");
}

function classifyPane(input: { label: string; process: string; cwd: string }): PaneKind {
  const label = input.label.trim().toLowerCase();
  const process = input.process.trim().toLowerCase();
  const cwd = input.cwd.trim().toLowerCase();

  if (label === "manual") return "manual";
  if (label.startsWith("ssh:")) return "ssh-shell";
  if (label.startsWith("agent:")) return "agent";
  if (process === "ssh") return "ssh-shell";
  if (["claude", "codex", "gemini", "kimi"].includes(process)) return "agent";
  if (cwd.includes("/.ssh")) return "ssh-shell";
  return "unknown";
}

function parseCsvEnv(name: string): string[] {
  return (process.env[name] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function paneMetadata(target: string): Promise<{ paneId: string; sessionWindow: string; label: string; cwd: string; process: string; kind: PaneKind }> {
  const output = await tmux(
    "display-message",
    "-t",
    target,
    "-p",
    "#{pane_id}|#{session_name}:#{window_index}|#{@name}|#{pane_current_path}|#{pane_current_command}"
  );
  const [paneId, sessionWindow, label, cwd, process] = output.trim().split("|");
  return {
    paneId,
    sessionWindow,
    label: label || "",
    cwd: cwd || "",
    process: process || "",
    kind: classifyPane({ label: label || "", process: process || "", cwd: cwd || "" }),
  };
}

function matchesAllowedTarget(metadata: { paneId: string; sessionWindow: string; label: string }, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  return (
    allowed.includes(metadata.paneId) ||
    allowed.includes(metadata.sessionWindow) ||
    (!!metadata.label && allowed.includes(metadata.label))
  );
}

async function assertReadableTarget(target: string, paneId: string): Promise<void> {
  const allowed = parseCsvEnv("TMUX_BRIDGE_READABLE_TARGETS");
  if (allowed.length === 0) return;
  const metadata = await paneMetadata(target);
  if (!matchesAllowedTarget(metadata, allowed)) {
    throw new Error(`Read blocked by target policy for pane ${paneId}`);
  }
}

async function assertWritableTarget(target: string, paneId: string): Promise<void> {
  const allowed = parseCsvEnv("TMUX_BRIDGE_WRITABLE_TARGETS");
  const metadata = await paneMetadata(target);
  if (
    metadata.kind === "manual" &&
    process.env.TMUX_BRIDGE_ALLOW_MANUAL_WRITE !== "1"
  ) {
    throw new Error(
      `Write blocked for manual pane ${metadata.label || paneId}; set TMUX_BRIDGE_ALLOW_MANUAL_WRITE=1 to override`
    );
  }
  if (allowed.length === 0) return;
  if (!matchesAllowedTarget(metadata, allowed)) {
    throw new Error(`Write blocked by target policy for pane ${paneId}`);
  }

  const readonlyRoots = parseCsvEnv("TMUX_BRIDGE_READONLY_PATHS");
  const writableRoots = parseCsvEnv("TMUX_BRIDGE_WRITABLE_PATHS");
  if (readonlyRoots.some((root) => metadata.cwd.startsWith(root))) {
    throw new Error(`Write blocked by readonly path policy for pane ${paneId}: ${metadata.cwd}`);
  }
  if (writableRoots.length > 0 && !writableRoots.some((root) => metadata.cwd.startsWith(root))) {
    throw new Error(`Write blocked by writable path policy for pane ${paneId}: ${metadata.cwd}`);
  }
}

async function assertPaneInputAllowed(target: string, text: string): Promise<void> {
  const metadata = await paneMetadata(target);
  if (metadata.kind !== "ssh-shell") return;
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) || "";
  if (!firstLine) return;
  const denyPrefixes = parseCsvEnv("TMUX_BRIDGE_DENY_PREFIXES");
  const defaults = ["rm -rf", "sudo", "reboot", "shutdown"];
  const prefixes = denyPrefixes.length > 0 ? denyPrefixes : defaults;
  if (prefixes.some((prefix) => firstLine === prefix || firstLine.startsWith(`${prefix} `))) {
    throw new Error(`Input blocked by command policy for ssh pane ${metadata.label || metadata.paneId}: ${firstLine}`);
  }
}
