import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "ps", "win.ps1");
const DEFAULT_PATTERN = "exocad|dentalcad|dentaldb";
const TIMEOUT_MS = 30_000;

const PATTERN = process.env.EXOCAD_WINDOW_RE ?? DEFAULT_PATTERN;
// shortcut: window title is the only filter; upgrade to process-name matching once real exocad process names are confirmed
try {
  new RegExp(PATTERN);
} catch {
  console.error(`EXOCAD_WINDOW_RE is not a valid regular expression: ${PATTERN}`);
  process.exit(1);
}

type Json = Record<string, unknown>;

function runWin(action: string, args: Json = {}): Promise<Json> {
  const argsB64 = Buffer.from(JSON.stringify(args), "utf8").toString("base64");
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-Action", action, "-Pattern", PATTERN, "-ArgsB64", argsB64],
      { timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        let parsed: Json | undefined;
        try {
          parsed = JSON.parse(stdout.trim()) as Json;
        } catch {
          /* fall through to generic error */
        }
        if (parsed?.error) return reject(new Error(String(parsed.error)));
        if (error || !parsed) return reject(new Error(`UI helper failed: ${error?.message ?? "no output"}`));
        resolve(parsed);
      }
    );
  });
}

const ACT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const SEE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const ok = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

// Screenshot coordinate space: clicks must use the scale of the latest screenshot.
let lastScale = 1;
const handle = z.number().int().optional().describe("Window handle from exocad_list_windows, when several windows match");
const point = { x: z.number().int().min(0).describe("X in screenshot pixels, from the left edge of the window"), y: z.number().int().min(0).describe("Y in screenshot pixels, from the top edge of the window") };
const button = z.enum(["left", "right", "middle"]).default("left");

export function registerGuiTools(server: McpServer): void {
  server.registerTool(
    "exocad_list_windows",
    {
      title: "List exocad windows",
      description: `List visible top-level windows whose title matches /${PATTERN}/ (override with EXOCAD_WINDOW_RE). All other GUI tools act only on these windows. Windows only.`,
      inputSchema: z.strictObject({}),
      annotations: SEE
    },
    async () => ok(JSON.stringify(await runWin("windows"), null, 2))
  );

  server.registerTool(
    "exocad_screenshot",
    {
      title: "Screenshot exocad window",
      description:
        "Bring the exocad window to the front and return a PNG of it. ALWAYS look at a screenshot before clicking. Click/drag/scroll coordinates are in the pixels of the latest screenshot (same scale). Use a smaller scale (e.g. 0.5) to save tokens when fine detail is not needed.",
      inputSchema: z.strictObject({
        scale: z.number().min(0.2).max(1).default(0.6).describe("1 = full resolution, 0.5 = half size"),
        handle
      }),
      annotations: ACT
    },
    async ({ scale, handle: h }) => {
      const r = await runWin("screenshot", { scale, handle: h });
      lastScale = Number(r.scale);
      return {
        content: [
          { type: "image" as const, data: String(r.png_base64), mimeType: "image/png" },
          { type: "text" as const, text: `${r.title} — ${r.width}x${r.height}px, scale ${r.scale}` }
        ]
      };
    }
  );

  server.registerTool(
    "exocad_list_controls",
    {
      title: "List UI controls",
      description:
        "Dump the accessibility tree of the exocad window: control type, name, automation id, position (window-relative, real pixels) and enabled state. Use it to find button names for exocad_click_control. Custom-drawn areas (the 3D viewport) do not appear here; use screenshots for those.",
      inputSchema: z.strictObject({
        depth: z.number().int().min(1).max(20).default(6).describe("Maximum nesting depth"),
        limit: z.number().int().min(1).max(1000).default(300).describe("Maximum controls to return"),
        handle
      }),
      annotations: SEE
    },
    async ({ depth, limit, handle: h }) => ok(JSON.stringify(await runWin("tree", { depth, limit, handle: h }), null, 1))
  );

  server.registerTool(
    "exocad_click_control",
    {
      title: "Click a control by name",
      description:
        "Activate a named control (button, checkbox, tab, menu item) via UI Automation, falling back to a click at its center. More reliable than coordinates when the control is listed by exocad_list_controls. Fails if the name is ambiguous: pass control_type (e.g. Button).",
      inputSchema: z.strictObject({
        name: z.string().min(1).describe("Control name exactly as shown by exocad_list_controls (case-insensitive)"),
        control_type: z.string().optional().describe("Optional filter, e.g. Button, CheckBox, TabItem, MenuItem"),
        handle
      }),
      annotations: ACT
    },
    async ({ name, control_type, handle: h }) => {
      const r = await runWin("invoke", { name, type: control_type, handle: h });
      return ok(`Clicked '${name}' (${r.method}). Take a screenshot to confirm.`);
    }
  );

  server.registerTool(
    "exocad_click",
    {
      title: "Click at a point",
      description: "Click at a point inside the exocad window, in the pixel space of the latest exocad_screenshot. Coordinates outside the window are refused.",
      inputSchema: z.strictObject({ ...point, button, double: z.boolean().default(false).describe("Double-click"), handle }),
      annotations: ACT
    },
    async ({ x, y, button: b, double, handle: h }) => {
      await runWin("click", { x, y, button: b, double, scale: lastScale, handle: h });
      return ok(`Clicked (${x},${y}) with ${b} button${double ? " twice" : ""}. Take a screenshot to confirm.`);
    }
  );

  server.registerTool(
    "exocad_drag",
    {
      title: "Drag in the window",
      description: "Press a mouse button at the start point, move to the end point and release. In the 3D viewport this rotates/pans the model (exocad's mouse mapping decides which button does what). Coordinates are in latest-screenshot pixels.",
      inputSchema: z.strictObject({
        x1: point.x, y1: point.y,
        x2: z.number().int().min(0).describe("End X"), y2: z.number().int().min(0).describe("End Y"),
        button, handle
      }),
      annotations: ACT
    },
    async ({ x1, y1, x2, y2, button: b, handle: h }) => {
      await runWin("drag", { x1, y1, x2, y2, button: b, scale: lastScale, handle: h });
      return ok(`Dragged (${x1},${y1}) -> (${x2},${y2}) with ${b} button.`);
    }
  );

  server.registerTool(
    "exocad_scroll",
    {
      title: "Scroll wheel",
      description: "Scroll the mouse wheel at a point (zooms the 3D viewport in exocad). Positive amount scrolls up/zooms in, negative down.",
      inputSchema: z.strictObject({ ...point, amount: z.number().int().min(-20).max(20).describe("Wheel notches, e.g. 3 or -3"), handle }),
      annotations: ACT
    },
    async ({ x, y, amount, handle: h }) => {
      await runWin("scroll", { x, y, amount, scale: lastScale, handle: h });
      return ok(`Scrolled ${amount} at (${x},${y}).`);
    }
  );

  server.registerTool(
    "exocad_type",
    {
      title: "Type text",
      description: "Type text into the focused field of the exocad window (click the field first). For shortcuts or Enter/Tab use exocad_key.",
      inputSchema: z.strictObject({ text: z.string().min(1).max(500), handle }),
      annotations: ACT
    },
    async ({ text, handle: h }) => {
      await runWin("type", { text, handle: h });
      return ok(`Typed ${text.length} characters.`);
    }
  );

  server.registerTool(
    "exocad_key",
    {
      title: "Press keys",
      description: "Press a key or combination in the exocad window: 'enter', 'tab', 'esc', 'f5', 'ctrl+s', 'ctrl+z', 'alt+f4'. Single keys: letters, digits, arrows, home/end, pageup/pagedown, delete, backspace, space.",
      inputSchema: z.strictObject({ keys: z.string().min(1).max(40).describe("e.g. 'ctrl+s'"), handle }),
      annotations: ACT
    },
    async ({ keys, handle: h }) => {
      await runWin("key", { keys, handle: h });
      return ok(`Pressed ${keys}.`);
    }
  );
}
