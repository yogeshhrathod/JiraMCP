import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

// Minimal fake Jira with a "PROJ" project, so nothing real is contacted.
const created: Array<Record<string, any>> = [];
const priorities = [{ id: "1", name: "P1-Critical" }, { id: "2", name: "P2-High" }, { id: "3", name: "P3-Low" }];
const datacenters = [{ id: "10", value: "DC-EAST" }, { id: "11", value: "DC-WEST" }];
const issueTypes = [{ id: "1", name: "Bug", subtask: false }, { id: "2", name: "Task", subtask: false }];
const fields = [
  { fieldId: "priority", name: "Priority", required: false, schema: { type: "priority", system: "priority" }, allowedValues: priorities },
  { fieldId: "summary", name: "Summary", required: true, schema: { type: "string", system: "summary" } },
  { fieldId: "customfield_100", name: "Datacenter", required: true, schema: { type: "option", custom: "x:select" }, allowedValues: datacenters },
];

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "", "http://x");
  const path = url.pathname.replace("/rest/api/2", "");
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.method === "GET" && path === "/project/PROJ") return send(200, { key: "PROJ", name: "Demo", id: "1", self: "", projectTypeKey: "software" });
    if (req.method === "GET" && path === "/project") return send(200, [{ key: "PROJ", name: "Demo", id: "1", self: "", projectTypeKey: "software" }]);
    if (req.method === "GET" && path.startsWith("/project/")) return send(404, { errorMessages: ["nope"] });
    if (req.method === "GET" && path === "/issue/createmeta/PROJ/issuetypes") return send(200, { values: issueTypes, total: 2 });
    if (req.method === "GET" && path === "/issue/createmeta/PROJ/issuetypes/1") return send(200, { values: fields, total: fields.length });
    if (req.method === "GET" && path === "/serverInfo") return send(200, { version: "9.9.9" });
    if (req.method === "POST" && path === "/issue") {
      created.push(JSON.parse(body));
      return send(201, { id: "100", key: "PROJ-1", self: "" });
    }
    if (req.method === "GET" && path === "/issue/PROJ-1") {
      return send(200, { id: "100", key: "PROJ-1", fields: { summary: "Broken", project: { key: "PROJ", name: "Demo" }, issuetype: { name: "Bug", id: "1" }, status: { name: "Open" } } });
    }
    send(404, { errorMessages: [`unhandled ${req.method} ${path}`] });
  });
});

let port = 0;
before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
after(() => server.close());

type Era = "legacy" | "modern";

async function connect(era: Era, elicitation: boolean, answer?: (title: string[]) => string) {
  const client = new Client(
    { name: "test", version: "1.0.0" },
    {
      capabilities: elicitation ? { elicitation: { form: {} } } : {},
      versionNegotiation: era === "modern" ? { mode: { pin: "2026-07-28" } } : undefined,
    } as never
  );
  const asked: string[] = [];
  if (elicitation) {
    client.setRequestHandler("elicitation/create", (async (request: any) => {
      const options = request.params.requestedSchema.properties.value.oneOf.map((o: any) => o.title);
      asked.push(request.params.message);
      const title = answer ? answer(options) : options[0];
      const chosen = request.params.requestedSchema.properties.value.oneOf.find((o: any) => o.title === title);
      return { action: "accept", content: { value: chosen.const } };
    }) as never);
  }
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/index.ts"],
      cwd: process.cwd(),
      env: { ...process.env, JIRA_BASE_URL: `http://127.0.0.1:${port}`, PAT: "test-token" } as Record<string, string>,
      stderr: "ignore",
    })
  );
  return { client, asked };
}

const text = (r: any) => r.content.find((c: any) => c.type === "text")?.text as string;

for (const era of ["legacy", "modern"] as Era[]) {
  test(`[${era}] negotiates the era and advertises annotated tools`, async () => {
    const { client } = await connect(era, false);
    try {
      assert.equal(client.getProtocolEra(), era);
      const { tools } = await client.listTools();
      assert.ok(tools.length >= 29);
      assert.ok(tools.every((t: any) => t.annotations && t.title));
      const del = tools.find((t: any) => t.name === "jira_delete_issue") as any;
      assert.equal(del.annotations.destructiveHint, true);
    } finally {
      await client.close();
    }
  });

  test(`[${era}] dry run resolves sloppy values against real options without creating`, async () => {
    const before = created.length;
    const { client } = await connect(era, false);
    try {
      const r: any = await client.callTool({
        name: "jira_create_issue_advanced",
        arguments: { projectKey: "proj", issueType: "bug", summary: "Broken", priority: "p2 high", customFields: { Datacenter: "dc-west" }, dryRun: true },
      });
      assert.ok(!r.isError, text(r));
      assert.deepEqual(r.structuredContent.payload.priority, { id: "2" });
      assert.deepEqual(r.structuredContent.payload.customfield_100, { id: "11" });
      assert.equal(created.length, before);
    } finally {
      await client.close();
    }
  });

  test(`[${era}] client without elicitation gets the valid options and nothing is created`, async () => {
    const before = created.length;
    const { client } = await connect(era, false);
    try {
      const r: any = await client.callTool({
        name: "jira_create_issue",
        arguments: { projectKey: "PROJ", issueType: "Bug", summary: "Broken", priority: "P9-Nope" },
      });
      assert.equal(r.isError, true);
      assert.match(text(r), /P1-Critical/);
      assert.match(text(r), /Datacenter/);
      assert.equal(created.length, before);
    } finally {
      await client.close();
    }
  });

  test(`[${era}] elicitation resolves an invalid value and a missing required field, then creates`, async () => {
    const before = created.length;
    const { client, asked } = await connect(era, true, (opts) => (opts.includes("DC-WEST") ? "DC-WEST" : "P2-High"));
    try {
      const r: any = await client.callTool({
        name: "jira_create_issue",
        arguments: { projectKey: "PROJ", issueType: "Bug", summary: "Broken", priority: "P9-Nope" },
      });
      assert.ok(!r.isError, text(r));
      assert.equal(asked.length, 2, `asked: ${asked.join(" | ")}`);
      assert.equal(created.length, before + 1);
      const fields = created.at(-1)!.fields;
      assert.deepEqual(fields.priority, { id: "2" });
      assert.deepEqual(fields.customfield_100, { id: "11" });
      assert.equal(r.structuredContent.key, "PROJ-1");
      assert.ok(r.content.some((c: any) => c.type === "resource_link" && c.uri === "jira://issue/PROJ-1"));
    } finally {
      await client.close();
    }
  });

  test(`[${era}] unknown project is suggested, not created`, async () => {
    const { client } = await connect(era, false);
    try {
      const r: any = await client.callTool({ name: "jira_create_issue", arguments: { projectKey: "PRO", issueType: "Bug", summary: "x", dryRun: true } });
      assert.equal(r.isError, true);
      assert.match(text(r), /PROJ/);
    } finally {
      await client.close();
    }
  });

  test(`[${era}] jira_report_issue redacts the instance host`, async () => {
    const { client } = await connect(era, false);
    try {
      const r: any = await client.callTool({
        name: "jira_report_issue",
        arguments: { tool: "jira_create_issue", problem: "fails", errorMessage: `GET http://127.0.0.1:${port}/rest/api/2/issue/PROJ-1 boom` },
      });
      assert.equal(r.structuredContent.filed, false);
      assert.ok(!JSON.stringify(r.structuredContent).includes(String(port)));
    } finally {
      await client.close();
    }
  });
}
