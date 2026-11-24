# exocad-mcp

Read-only [MCP](https://modelcontextprotocol.io) server that lets an AI assistant browse **exocad** case folders on disk.

> Unofficial community project. Not affiliated with, endorsed by, or supported by exocad GmbH. "exocad" is a trademark of its owner.

exocad does not publish an open scripting API, so this server does **not** control the exocad application. It reads the files exocad leaves on disk (`.dentalProject` / `.constructionInfo` XML) and lists the rest of the case folder.

## Tools

| Tool | What it does |
|---|---|
| `exocad_list_cases` | Finds case folders under the projects root (newest first), optional name filter, paginated |
| `exocad_get_case` | Lists a case's files and returns its project XML parsed to JSON |

Both are read-only and cannot leave the projects root (paths and symlinks are checked).

## Privacy

Case files normally contain patient data. `exocad_get_case` redacts keys that look patient-identifying (names, birth date, contact data) unless `include_patient_info=true`. This is a **best-effort key-name heuristic**, not anonymisation: free-text fields and project names may still contain identifying data. Only point the server at data you are allowed to share with your AI provider.

## Status / limitations

- The XML is returned as generic JSON; there is no schema-aware mapping (teeth, materials, indications) yet, because the format is not publicly documented. Written against a hand-made fixture, so real-world files may need tweaks. Issues and sample (anonymised) files welcome.
- Does not parse STL/PLY/DCM meshes.

## Install

```bash
git clone https://github.com/Dzondaar/exocad-mcp && cd exocad-mcp
npm install && npm run build
```

Claude Desktop / any MCP client (stdio):

```json
{
  "mcpServers": {
    "exocad": {
      "command": "node",
      "args": ["C:/path/to/exocad-mcp/dist/index.js"],
      "env": { "EXOCAD_PROJECTS_ROOT": "C:/path/to/your/exocad/cases" }
    }
  }
}
```

## Develop

```bash
npm run build && npm run smoke   # self-check against fixtures/
```

MIT licensed.
