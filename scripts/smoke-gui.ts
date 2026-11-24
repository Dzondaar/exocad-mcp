/**
 * GUI self-check on Windows against a throwaway WinForms window (scripts/testwindow.ps1), never a real app.
 * Run with: npm run build && npm run smoke:gui
 */
import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

// Host the test window in a renamed copy of powershell.exe: the real one is on the helper's deny list (terminals/shells are never targeted).
const host = path.join(os.tmpdir(), "exocadtesthost.exe");
copyFileSync(path.join(process.env.SystemRoot ?? "C:\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), host);
const note = spawn(host, ["-NoProfile", "-STA", "-File", "scripts/testwindow.ps1"], { stdio: "ignore" });
await new Promise(r => setTimeout(r, 2500));

const client = new Client({ name: "smoke-gui", version: "1.0.0" });
try {
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: ["dist/index.js"],
      env: { ...getDefaultEnvironment(), EXOCAD_WINDOW_RE: "ExocadMcpSmokeTest" }
    })
  );
  const call = (name: string, args: object = {}) => { console.error("->", name); return client.callTool({ name, arguments: args }); };
  const text = (r: any) => (r.content.find((c: any) => c.type === "text")?.text ?? "") as string;

  const { tools } = await client.listTools();
  assert.ok(tools.some(t => t.name === "exocad_screenshot"));
  assert.ok(!tools.some(t => t.name === "exocad_list_cases"), "file tools need EXOCAD_PROJECTS_ROOT");

  const wins = await call("exocad_list_windows");
  assert.match(text(wins), /ExocadMcpSmokeTest/);

  const shot: any = await call("exocad_screenshot", { scale: 0.5 });
  assert.ok(!shot.isError, text(shot));
  const img = shot.content.find((c: any) => c.type === "image");
  assert.equal(Buffer.from(img.data, "base64").subarray(1, 4).toString(), "PNG");
  const [, w, h] = text(shot).match(/(\d+)x(\d+)px/)!.map(Number);

  const tree = await call("exocad_list_controls", { depth: 8 });
  assert.ok(!tree.isError, text(tree));
  assert.ok(JSON.parse(text(tree)).count > 0, "tree should contain controls");

  // click inside the window, type, select all; verify through the accessibility tree
  assert.ok(!(await call("exocad_click", { x: Math.floor(w / 2), y: Math.floor(h / 2) })).isError);
  assert.ok(!(await call("exocad_type", { text: "diente 11 (zirconia) +50%" })).isError);
  assert.ok(!(await call("exocad_key", { keys: "ctrl+a" })).isError);
  const typed = JSON.parse(text(await call("exocad_list_controls", { depth: 3 }))).controls.find((c: any) => c.type === "Document");
  assert.equal(typed.name, "diente 11 (zirconia) +50%"); // special characters typed literally

  // control-by-name path: the button renames the window title
  assert.match(text(await call("exocad_click_control", { name: "Aceptar", control_type: "Button" })), /Clicked/);
  await new Promise(r => setTimeout(r, 300));
  assert.match(text(await call("exocad_list_windows")), /clicked/);

  // safety: points outside the window and unknown controls are refused
  const outside = await call("exocad_click", { x: w + 500, y: h + 500 });
  assert.equal(outside.isError, true);
  assert.match(text(outside), /outside the window/);
  assert.equal((await call("exocad_click_control", { name: "no such control zzz" })).isError, true);
  assert.equal((await call("exocad_key", { keys: "ctrl+banana" })).isError, true);

  await client.close();
  console.error("gui smoke passed");
} finally {
  try {
    execFileSync("taskkill", ["/PID", String(note.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* already closed */
  }
}
