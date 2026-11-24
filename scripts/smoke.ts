import { strict as assert } from "node:assert";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...getDefaultEnvironment(), EXOCAD_PROJECTS_ROOT: path.resolve("fixtures/projects") }
  })
);
const call = (name: string, args: object) => client.callTool({ name, arguments: args });
const body = (r: any) => r.content[0].text as string;

const list = await call("exocad_list_cases", {});
assert.ok(!list.isError);
assert.match(body(list), /CASE-001/);
assert.match(body(await call("exocad_list_cases", { query: "nomatch" })), /No cases/);

const redacted = body(await call("exocad_get_case", { path: "CASE-001" }));
assert.match(redacted, /Zirconia/);
assert.doesNotMatch(redacted, /Jane/);
assert.match(redacted, /CASE-001_upper\.stl/);
assert.match(body(await call("exocad_get_case", { path: "CASE-001", include_patient_info: true })), /Jane/);

for (const bad of ["../", "..\\..", "/etc", "nope"]) {
  assert.equal((await call("exocad_get_case", { path: bad })).isError, true, `should reject ${bad}`);
}
await client.close();
console.error("smoke passed");
