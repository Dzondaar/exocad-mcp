import { promises as fs } from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";

const CASE_MARKERS = [".dentalproject", ".constructioninfo"];
const MAX_XML_BYTES = 5 * 1024 * 1024;
const MAX_VISITED_DIRS = 20_000;
const MAX_DEPTH = 4;
// shortcut: key-name heuristic, not a guarantee of anonymisation; upgrade once the real schema is confirmed
const SENSITIVE_KEY = /patient|birth|address|phone|e-?mail|ssn|insurance|first.?name|last.?name/i;

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

export interface CaseSummary {
  name: string;
  path: string; // relative to the projects root, forward slashes
  modified: string;
  projectFiles: string[];
}

const isMarker = (file: string) => CASE_MARKERS.some(m => file.toLowerCase().endsWith(m));
const toRel = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join("/") || ".";

export async function realRoot(root: string): Promise<string> {
  return fs.realpath(root);
}

/** Resolves a user-supplied relative path and refuses anything that escapes the root (incl. symlinks). */
export async function resolveInside(root: string, rel: string): Promise<string> {
  const abs = await fs.realpath(path.resolve(root, rel)).catch(() => {
    throw new Error(`Case not found: '${rel}'. Use exocad_list_cases to get valid paths.`);
  });
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path '${rel}' is outside the projects root.`);
  }
  return abs;
}

export async function findCases(root: string): Promise<CaseSummary[]> {
  const found: CaseSummary[] = [];
  let visited = 0;
  async function walk(dir: string, depth: number): Promise<void> {
    if (visited++ > MAX_VISITED_DIRS) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const projectFiles = entries.filter(e => e.isFile() && isMarker(e.name)).map(e => e.name);
    if (projectFiles.length > 0) {
      const stat = await fs.stat(dir);
      found.push({ name: path.basename(dir), path: toRel(root, dir), modified: stat.mtime.toISOString(), projectFiles });
      return; // a case folder is a leaf
    }
    if (depth >= MAX_DEPTH) return;
    for (const e of entries) if (e.isDirectory()) await walk(path.join(dir, e.name), depth + 1);
  }
  await walk(root, 0);
  return found.sort((a, b) => b.modified.localeCompare(a.modified));
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v)])
    );
  }
  return value;
}

async function readProjectXml(file: string): Promise<unknown> {
  const stat = await fs.stat(file);
  if (stat.size > MAX_XML_BYTES) throw new Error(`${path.basename(file)} is larger than 5 MB; refusing to parse.`);
  return parser.parse(await fs.readFile(file, "utf8"));
}

export async function readCase(caseDir: string, includePatientInfo: boolean) {
  const entries = await fs.readdir(caseDir, { withFileTypes: true });
  const files: { name: string; bytes: number }[] = [];
  for (const e of entries) {
    if (e.isFile()) files.push({ name: e.name, bytes: (await fs.stat(path.join(caseDir, e.name))).size });
  }
  const projects: Record<string, unknown> = {};
  for (const f of files.filter(f => isMarker(f.name))) {
    try {
      const data = await readProjectXml(path.join(caseDir, f.name));
      projects[f.name] = includePatientInfo ? data : redact(data);
    } catch (error) {
      projects[f.name] = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { name: path.basename(caseDir), files, projects, patient_info_included: includePatientInfo };
}
