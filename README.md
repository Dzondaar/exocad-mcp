# exocad-mcp

[MCP](https://modelcontextprotocol.io) server that lets an AI assistant (Claude, etc.) **operate exocad on Windows** the way a person would: look at the window, click, type, drag in the 3D view, and read case files.

> Unofficial community project. Not affiliated with, endorsed by, or supported by exocad GmbH. "exocad" is a trademark of its owner.

## How it works (and why it is not like Blender's MCP)

Blender has an embedded Python API, so an MCP can run code inside it. **exocad has no public scripting API**, so this server drives the *user interface* with Windows UI Automation and simulated mouse/keyboard, and the AI works from screenshots. Expect it to be slower and less exact than an API:

- Great for repetitive steps: create/open a case, load scans, advance the wizard, apply the same settings, export STL.
- The 3D viewport is custom-drawn, so it can only be seen through screenshots. Fine adjustments (margins, contacts, anatomy) still need a human eye.
- Layout, language and version of exocad change what works. **This has not yet been tested against a real exocad install** (see Status).

## Tools

GUI tools (Windows only; they act **only** on windows whose title matches `EXOCAD_WINDOW_RE`, default `exocad|dentalcad|dentaldb`):

| Tool | What it does |
|---|---|
| `exocad_list_windows` | Matching windows (title, process, handle) |
| `exocad_screenshot` | Brings the window to the front, returns a PNG (adjustable scale) |
| `exocad_list_controls` | Accessibility tree: buttons/tabs/fields with names and positions |
| `exocad_click_control` | Click a control by name (reliable) |
| `exocad_click` / `exocad_drag` / `exocad_scroll` | Mouse at screenshot coordinates (rotate/pan/zoom the viewport) |
| `exocad_type` / `exocad_key` | Type text; press keys like `ctrl+s`, `enter`, `f5` |

File tools (only when `EXOCAD_PROJECTS_ROOT` is set; read-only, cannot leave that folder):

| Tool | What it does |
|---|---|
| `exocad_list_cases` | Find case folders (`.dentalProject` / `.constructionInfo`), newest first |
| `exocad_get_case` | List a case's files and return its project XML as JSON, patient fields redacted by default |

## Safety and privacy

- Mouse and keyboard actions are refused outside the target window; terminals, shells, browsers and similar apps are excluded even if their title matches.
- The AI can click anything inside exocad, including delete/overwrite buttons. Work on copies of cases and keep exocad's own undo/backups in mind.
- **Screenshots and case XML go to your AI provider and can show patient data.** Only use real patient cases if you are allowed to. File-tool redaction is a best-effort key-name heuristic, not anonymisation.

## Install

Requires Node 20.3+ and Windows for the GUI tools.

```bash
git clone https://github.com/Dzondaar/exocad-mcp && cd exocad-mcp
npm install && npm run build
```

MCP client config (e.g. Claude Desktop):

```json
{
  "mcpServers": {
    "exocad": {
      "command": "node",
      "args": ["C:/path/to/exocad-mcp/dist/index.js"],
      "env": {
        "EXOCAD_WINDOW_RE": "exocad|dentalcad",
        "EXOCAD_PROJECTS_ROOT": "C:/path/to/your/exocad/cases"
      }
    }
  }
}
```

`EXOCAD_PROJECTS_ROOT` is optional. If your exocad window title differs, run `exocad_list_windows` with `EXOCAD_WINDOW_RE=.` once to see titles, then set the regex.

## Status

- Verified by `npm run smoke:gui` against a throwaway test window (screenshots, tree, click, type, keys, click-by-name, out-of-window refusal) and `npm run smoke` for the file tools.
- **Not yet verified against a real exocad.** Window titles, control names and the viewport mouse mapping are unknown until someone runs it. Please open an issue with the output of `exocad_list_windows` and `exocad_list_controls` (no patient data!) from your version, and what worked.
- File tools return the XML as generic JSON; there is no schema-aware mapping (teeth, materials) because the format is not public.

MIT licensed.
