#!/usr/bin/env node
/** Read-only MCP server for exocad project folders. stdio transport. */
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { findCases, readCase, realRoot, resolveInside } from "./cases.js";
import { registerGuiTools } from "./gui.js";

const CHARACTER_LIMIT = 25_000;
// File tools need EXOCAD_PROJECTS_ROOT; GUI tools need Windows. Each group is registered only when usable.
const rootEnv = process.env.EXOCAD_PROJECTS_ROOT;
const ROOT = rootEnv
  ? await realRoot(path.resolve(rootEnv)).catch(() => {
      console.error(`EXOCAD_PROJECTS_ROOT does not exist: ${rootEnv}`);
      process.exit(1);
    })
  : undefined;
const GUI = process.platform === "win32";
if (!ROOT && !GUI) {
  console.error("Nothing to serve: set EXOCAD_PROJECTS_ROOT (case folder tools) or run on Windows (GUI tools).");
  process.exit(1);
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function createServer(): McpServer {
  const server = new McpServer({ name: "exocad-mcp", version: "0.2.0" });
  if (GUI) registerGuiTools(server);
  if (ROOT) registerFileTools(server, ROOT);
  return server;
}

function registerFileTools(server: McpServer, ROOT: string): void {
  server.registerTool(
    "exocad_list_cases",
    {
      title: "List exocad cases",
      description:
        "List exocad case folders (folders holding a .dentalProject or .constructionInfo file) under the configured projects root, newest first. " +
        "Returns each case's relative path, last-modified time and project files. Optional 'query' filters by folder name or path (case-insensitive substring). " +
        "Use exocad_get_case with a returned path for details. Example: 'which cases did I work on recently' -> no arguments.",
      inputSchema: z.strictObject({
        query: z.string().max(200).optional().describe("Substring to match against case folder name/path"),
        limit: z.number().int().min(1).max(100).default(20).describe("Maximum cases to return"),
        offset: z.number().int().min(0).default(0).describe("Cases to skip, for pagination")
      }),
      annotations: READ_ONLY
    },
    async ({ query, limit, offset }) => {
      const all = (await findCases(ROOT)).filter(c => !query || c.path.toLowerCase().includes(query.toLowerCase()));
      if (all.length === 0) return text("No cases found. Check 'query', or that EXOCAD_PROJECTS_ROOT points at your cases folder.");
      let page = all.slice(offset, offset + limit);
      const render = () => {
        const next = offset + page.length;
        const more = next < all.length;
        return JSON.stringify({ total: all.length, count: page.length, offset, cases: page, has_more: more, ...(more ? { next_offset: next } : {}) }, null, 2);
      };
      let out = render();
      while (page.length > 1 && out.length > CHARACTER_LIMIT) {
        page = page.slice(0, Math.ceil(page.length / 2));
        out = render();
      }
      return text(out);
    }
  );

  server.registerTool(
    "exocad_get_case",
    {
      title: "Get exocad case",
      description:
        "Read one exocad case folder: its files (name, size) and the parsed contents of its .dentalProject / .constructionInfo XML files as JSON. " +
        "Patient-identifying fields (names, birth date, contact data) are redacted by default (best effort, by key name); set include_patient_info=true only when the user needs them. " +
        "Does not open scan/mesh files (STL/PLY). Use exocad_list_cases first to get 'path'.",
      inputSchema: z.strictObject({
        path: z.string().min(1).describe("Case folder path relative to the projects root, as returned by exocad_list_cases"),
        include_patient_info: z.boolean().default(false).describe("Include patient-identifying fields unredacted")
      }),
      annotations: READ_ONLY
    },
    async ({ path: rel, include_patient_info }) => {
      const dir = await resolveInside(ROOT, rel);
      const out = JSON.stringify(await readCase(dir, include_patient_info), null, 2);
      return text(out.length > CHARACTER_LIMIT ? `${out.slice(0, CHARACTER_LIMIT)}\n[truncated at ${CHARACTER_LIMIT} chars]` : out);
    }
  );
}

serveStdio(createServer);
console.error(`exocad-mcp running on stdio (cases root: ${ROOT ?? "none"}, GUI tools: ${GUI})`);
