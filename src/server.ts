import {
  McpServer,
  ResourceTemplate,
  completable,
  isInputRequiredResult,
  type CallToolResult,
  type InputRequiredResult,
  type ServerContext,
} from "@modelcontextprotocol/server";
import * as z from "zod";
import { JiraApiError, JiraConnectionError, type JiraClient } from "./jira-client.js";
import { FailureTracker, buildReport, issueHint } from "./issue-report.js";
import { createFlow, loadAnswers, pendingResult, requestStateVerify, supportsElicitation, type Flow } from "./elicitation.js";
import { PENDING } from "./smart-fields.js";
import { requestSignal } from "./request-context.js";
import { fieldOptions, findProjects, prepareCreate, prepareTransition, prepareUpdate, type Prepared } from "./workflows.js";

export interface ServerDeps {
  client: JiraClient;
  version: string;
  baseUrl: string;
  bugsUrl: string;
  homepage?: string;
}

const warn = (message: string) => console.error(`[jira-mcp] ${message}`);

const ok = (data: Record<string, unknown>, links: Array<{ key: string; title?: string }> = []): CallToolResult => ({
  content: [
    { type: "text", text: JSON.stringify(data, null, 2) },
    ...links.map((l) => ({ type: "resource_link" as const, uri: `jira://issue/${l.key}`, name: l.key, title: l.title, mimeType: "application/json" })),
  ],
  structuredContent: data,
});

const passthrough = (data: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  structuredContent: (Array.isArray(data) ? { items: data } : (data ?? {})) as Record<string, unknown>,
});

const fail = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });

function needsInput(headline: string, prep: Extract<Prepared, { ready: false }>): CallToolResult {
  const lines = prep.problems.map((p) => `- ${p.message}`);
  return {
    isError: true,
    content: [{ type: "text", text: `${headline} Input needed:\n${lines.join("\n")}` }],
    structuredContent: { problems: prep.problems, notes: prep.notes },
  };
}

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const EDIT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const DESTROY = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } as const;

const DAY = 24 * 60 * 60_000;
const FIVE_MIN = 5 * 60_000;
const STATIC_META = { ttlMs: FIVE_MIN, cacheScope: "private" } as const;

const issueKey = z.string().describe("Jira issue key, e.g. PROJ-123");
const customFields = z
  .record(z.string(), z.unknown())
  .optional()
  .describe('Extra fields keyed by field id OR display name, e.g. {"Datacenter": "IN03", "customfield_10001": "value"}. Values for dropdown/multi-select/cascading fields are matched against the real options.');

const createBase = {
  projectKey: z.string().describe("Project key. If it does not exist, the closest existing projects are suggested."),
  summary: z.string().describe("Issue summary"),
  issueType: z.string().describe("Issue type name; matched against the project's real issue types"),
  description: z.string().optional().describe("Issue description"),
  priority: z.string().optional().describe("Priority name; matched against the allowed priorities"),
  assignee: z.string().optional().describe("Assignee username"),
  labels: z.array(z.string()).optional().describe("Labels"),
  dryRun: z.boolean().optional().describe("Validate and resolve all values but do not create the issue; returns the exact payload"),
};
const createAdvanced = {
  ...createBase,
  reporter: z.string().optional().describe("Reporter username"),
  components: z.array(z.string()).optional().describe("Component names"),
  fixVersions: z.array(z.string()).optional().describe("Fix version names"),
  affectsVersions: z.array(z.string()).optional().describe("Affects version names"),
  customFields,
};
const updateBase = {
  issueKey,
  summary: z.string().optional().describe("New summary"),
  description: z.string().optional().describe("New description"),
  priority: z.string().optional().describe("New priority name"),
  assignee: z.string().optional().describe("New assignee username"),
  labels: z.array(z.string()).optional().describe("New labels"),
};
const updateAdvanced = {
  ...updateBase,
  components: z.array(z.string()).optional().describe("Component names"),
  fixVersions: z.array(z.string()).optional().describe("Fix version names"),
  affectsVersions: z.array(z.string()).optional().describe("Affects version names"),
  customFields,
};

const ticketOutput = z.object({
  key: z.string().optional(),
  id: z.string().optional(),
  project: z.looseObject({ key: z.string(), name: z.string().optional() }).optional(),
  issueType: z.string().optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  assignee: z.string().optional(),
  summary: z.string().optional(),
  recovered: z.boolean().optional(),
  created: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  metaSource: z.string().optional(),
  notes: z.array(z.string()).optional(),
  moveNote: z.string().optional(),
  recoveryNote: z.string().optional(),
});
const changeOutput = z.object({ issueKey: z.string(), changed: z.boolean(), notes: z.array(z.string()).optional(), transition: z.string().optional() });

export function createServer({ client, version, baseUrl, bugsUrl, homepage }: ServerDeps): McpServer {
  const mcp = new McpServer(
    { name: "jira-mcp-server", title: "Jira MCP Server", version, ...(homepage && { websiteUrl: homepage }) },
    {
      instructions: [
        "Jira server for self-hosted Jira (PAT auth).",
        "Creating or changing tickets: pass human-readable values (e.g. priority 'High', a dropdown label). The server checks them against the field's real selectable options, fixes harmless differences (case, spacing, unique partial names), and asks the user (or returns the valid options) when a value is ambiguous, invalid or a required field is missing.",
        "Never guess a value the server rejected: show the user the listed options and retry with their choice.",
        "Use dryRun=true on create tools to preview the exact payload without creating anything.",
        "A create response may report a different key/project than requested if Jira automation moved the ticket; always report the returned key.",
        "If a create call fails with a connection error, do NOT retry blindly; the server already searches for the created ticket, and the error says whether it was found.",
        "If the same tool keeps failing with the same error, or an error looks like a server bug or unsupported Jira setup that you cannot work around by changing inputs, stop retrying and suggest the user report it: call jira_report_issue to prepare a redacted GitHub issue draft (nothing is filed automatically).",
        'Jira text search (summary ~ "x") does not match version-like strings such as 5.3.0-14; search by reporter, created date or labels instead.',
      ].join("\n"),
      requestState: { verify: requestStateVerify },
      cacheHints: {
        "tools/list": { ttlMs: DAY, cacheScope: "public" },
        "prompts/list": { ttlMs: DAY, cacheScope: "public" },
        "resources/templates/list": { ttlMs: DAY, cacheScope: "public" },
        "resources/list": { ttlMs: FIVE_MIN, cacheScope: "private" },
      },
    }
  );

  // ---------- plumbing ----------

  const unexpectedResults = new WeakSet<object>();
  const failures = new FailureTracker();

  // Runs a handler with the request's abort signal in scope (cancellation reaches Jira HTTP calls),
  // converts exceptions to tool errors, and appends "report a bug" advice for repeated/unexpected failures.
  const guard = (name: string, cb: (args: never, ctx: ServerContext) => Promise<CallToolResult | InputRequiredResult>) =>
    (async (args: never, ctx: ServerContext) => {
      let result: CallToolResult;
      try {
        const out = await requestSignal.run(ctx.mcpReq.signal, () => cb(args, ctx));
        if (isInputRequiredResult(out)) return out;
        result = out as CallToolResult;
      } catch (error) {
        const expected = error instanceof JiraApiError ? error.status < 500 : error instanceof JiraConnectionError;
        if (!expected) warn(`unexpected error in ${name}: ${error instanceof Error ? error.name : "unknown"}`);
        result = fail(describeError(error));
        if (!expected) unexpectedResults.add(result);
      }
      if (!result.isError) {
        failures.clear(name);
        return result;
      }
      const text = result.content.find((c) => c.type === "text");
      const count = failures.record(name, text && "text" in text ? text.text : "");
      const hint = issueHint({ tool: name, count, unexpected: unexpectedResults.has(result), bugsUrl });
      return hint ? { ...result, content: [...result.content, { type: "text" as const, text: hint }] } : result;
    }) as never;

  const tool = (name: string, config: Record<string, unknown>, cb: Parameters<typeof guard>[1]) =>
    (mcp.registerTool as (n: string, c: unknown, f: unknown) => unknown)(name, config, guard(name, cb));

  const readTool = <S extends z.ZodRawShape>(
    name: string,
    title: string,
    description: string,
    shape: S,
    fn: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>
  ) => tool(name, { title, description, inputSchema: z.object(shape), annotations: READ }, (async (a: z.infer<z.ZodObject<S>>) => passthrough(await fn(a))) as never);

  // Elicitation is multi-round-trip: answers from earlier rounds are replayed, new questions are
  // queued and returned as input_required. Clients without elicitation get problems with options instead.
  async function withFlow(ctx: ServerContext, body: (flow?: Flow) => Promise<CallToolResult>) {
    const flow = supportsElicitation(ctx, mcp.server.getClientCapabilities()) ? createFlow(loadAnswers(ctx)) : undefined;
    const result = await body(flow);
    return (await pendingResult(flow)) ?? result;
  }

  async function progress(ctx: ServerContext, step: number, total: number, message: string) {
    const progressToken = ctx.mcpReq._meta?.progressToken;
    if (progressToken === undefined) return;
    await ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken, progress: step, total, message } }).catch(() => undefined);
  }

  let projectCache: { at: number; keys: Array<{ key: string; name: string }> } | undefined;
  async function projectKeys() {
    if (!projectCache || Date.now() - projectCache.at > FIVE_MIN) {
      const projects = await client.getProjects();
      projectCache = { at: Date.now(), keys: projects.map((p) => ({ key: p.key, name: p.name })) };
    }
    return projectCache.keys;
  }
  const completeProject = async (value: string) => {
    try {
      const v = value.toLowerCase();
      return (await projectKeys())
        .filter((p) => p.key.toLowerCase().includes(v) || p.name.toLowerCase().includes(v))
        .slice(0, 50)
        .map((p) => p.key);
    } catch {
      return [];
    }
  };

  async function describeCreated(created: { key: string; recovered: boolean }) {
    const issue = await client.getCreatedIssue(created.key).catch(() => undefined);
    if (!issue) return { key: created.key, recovered: created.recovered };
    return {
      id: issue.id,
      key: issue.key,
      project: issue.fields.project,
      issueType: issue.fields.issuetype?.name,
      status: issue.fields.status?.name,
      priority: issue.fields.priority?.name,
      assignee: issue.fields.assignee?.name,
      summary: issue.fields.summary,
      recovered: created.recovered,
      ...(issue.key !== created.key && { moveNote: `Issue was moved server-side: created as ${created.key}, now ${issue.key}` }),
      ...(created.recovered && {
        recoveryNote: "The create response was lost (timeout/connection drop), but the matching issue was found on the server. Do NOT retry the create.",
      }),
    };
  }

  // ---------- create / update / transition (smart) ----------

  const handleCreate = (async (args: z.infer<z.ZodObject<typeof createAdvanced>>, ctx: ServerContext) =>
    withFlow(ctx, async (flow) => {
      await progress(ctx, 1, 3, "Resolving field values");
      const prep = await prepareCreate(client, args, flow);
      if (!prep.ready) return needsInput("Ticket was NOT created.", prep);
      if (args.dryRun) return ok({ dryRun: true, created: false, payload: prep.fields, notes: prep.notes, metaSource: prep.metaSource });
      await progress(ctx, 2, 3, "Creating issue");
      const created = await client.createIssueWithRecovery(prep.fields);
      if (created.recovered) warn(`create response lost; recovered ${created.key}`);
      await progress(ctx, 3, 3, "Done");
      const summary = await describeCreated(created);
      return ok({ ...summary, created: true, notes: prep.notes }, [{ key: String(summary.key), title: "summary" in summary ? summary.summary : undefined }]);
    })) as never;

  tool(
    "jira_create_issue",
    {
      title: "Create Jira issue",
      description:
        "Create a Jira issue. Values are validated and resolved against the project's real selectable options (issue type, priority, dropdowns); ambiguous/invalid values or missing required fields are asked of the user or returned with the valid options. Reports the actual key/project of the created ticket and recovers from lost responses instead of risking duplicates.",
      inputSchema: z.object(createBase),
      outputSchema: ticketOutput,
      annotations: CREATE,
    },
    handleCreate
  );

  tool(
    "jira_create_issue_advanced",
    {
      title: "Create Jira issue (all fields)",
      description:
        "Create a Jira issue with components, versions, reporter and custom fields (by id or display name). Same smart option resolution, required-field handling and duplicate-safe recovery as jira_create_issue. Use jira_get_create_meta / jira_get_field_options to explore fields.",
      inputSchema: z.object(createAdvanced),
      outputSchema: ticketOutput,
      annotations: CREATE,
    },
    handleCreate
  );

  const handleUpdate = (async (args: z.infer<z.ZodObject<typeof updateAdvanced>>, ctx: ServerContext) =>
    withFlow(ctx, async (flow) => {
      const { issueKey: key, ...rest } = args;
      const prep = await prepareUpdate(client, key, rest, flow);
      if (!prep.ready) return needsInput(`${key} was NOT updated.`, prep);
      if (!Object.keys(prep.fields).length) return fail("No fields to update were provided.");
      await client.updateIssueRaw(key, prep.fields);
      return ok({ issueKey: key, changed: true, notes: prep.notes }, [{ key }]);
    })) as never;

  tool(
    "jira_update_issue",
    {
      title: "Update Jira issue",
      description: "Update basic fields of an issue. Values are checked against the issue's editable fields and their allowed options.",
      inputSchema: z.object(updateBase),
      outputSchema: changeOutput,
      annotations: EDIT,
    },
    handleUpdate
  );

  tool(
    "jira_update_issue_advanced",
    {
      title: "Update Jira issue (all fields)",
      description: "Update any editable field including components, versions and custom fields (by id or display name), with allowed-option matching.",
      inputSchema: z.object(updateAdvanced),
      outputSchema: changeOutput,
      annotations: EDIT,
    },
    handleUpdate
  );

  tool(
    "jira_transition_issue",
    {
      title: "Transition Jira issue",
      description:
        "Move an issue to a new status by transition name or id. Transition-screen fields (e.g. resolution, assignee, comment) are resolved against the transition's real options; missing required ones are asked of the user or listed. Call jira_get_transitions to see transitions and their required fields.",
      inputSchema: z.object({
        issueKey,
        transition: z.string().optional().describe("Transition name (e.g. 'Close Issue') or target status name"),
        transitionId: z.string().optional().describe("Transition id (alternative to transition)"),
        comment: z.string().optional().describe("Comment to add with the transition"),
        fields: z.record(z.string(), z.unknown()).optional().describe('Transition-screen fields, e.g. {"resolution": "Fixed"}'),
      }),
      outputSchema: changeOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (async (a: { issueKey: string; transition?: string; transitionId?: string; comment?: string; fields?: Record<string, unknown> }, ctx: ServerContext) =>
      withFlow(ctx, async (flow) => {
        const prep = await prepareTransition(client, a.issueKey, a, flow);
        if (!prep.ready) return needsInput(`${a.issueKey} was NOT transitioned.`, prep);
        await client.transitionIssue(a.issueKey, prep.transitionId, prep.comment, prep.fields);
        return ok({ issueKey: a.issueKey, changed: true, transition: prep.transitionName, notes: prep.notes }, [{ key: a.issueKey }]);
      })) as never
  );

  // ---------- discovery tools ----------

  readTool("jira_find_project", "Find Jira project", "Find projects by key or name (fuzzy). Use when a project key is unknown, renamed or split into other projects.", {
    query: z.string().describe("Text to look for in project key or name"),
    limit: z.number().int().positive().max(50).optional().describe("Max results (default 10)"),
  }, async ({ query, limit }) => ({ projects: (await findProjects(client, query, limit ?? 10)).map((p) => ({ key: p.key, name: p.name })) }));

  readTool(
    "jira_get_field_options",
    "Get selectable options for a field",
    "List the allowed values of a dropdown/select/version/component/priority field, optionally ranked against a query. Give issueKey (accurate for existing issues) or projectKey + issueType. fieldKey may be the field id or display name.",
    {
      fieldKey: z.string().describe("Field id (e.g. priority, customfield_10001) or display name"),
      issueKey: z.string().optional().describe("Existing issue to read editable field options from"),
      projectKey: z.string().optional().describe("Project key (with issueType) for create-time options"),
      issueType: z.string().optional().describe("Issue type name (with projectKey)"),
      query: z.string().optional().describe("Rank options by similarity to this text"),
      limit: z.number().int().positive().max(200).optional().describe("Max options"),
    },
    (a) => fieldOptions(client, a)
  );

  readTool(
    "jira_get_create_meta",
    "Get create metadata",
    "Fields (required flag, type, allowed values) for creating an issue of a project/issue type. Works across Jira versions by falling back to other metadata endpoints; 'accurate: false' means it is approximated from an existing issue's edit metadata.",
    { projectKey: z.string().describe("Project key"), issueType: z.string().optional().describe("Issue type name") },
    ({ projectKey, issueType }) => client.getCreateMeta(projectKey, issueType)
  );

  readTool("jira_get_edit_meta", "Get edit metadata", "Editable fields and allowed values for an existing issue.", { issueKey }, ({ issueKey: k }) => client.getEditMeta(k));

  // ---------- plain tools ----------

  readTool("jira_get_issue", "Get Jira issue", "Get an issue by key.", { issueKey, expand: z.array(z.string()).optional().describe("Fields to expand") }, ({ issueKey: k, expand }) => client.getIssue(k, expand));

  tool(
    "jira_search_issues",
    {
      title: "Search Jira issues",
      description: 'Search with JQL. Note: the text operator (summary ~ "x") does not match version-like strings such as 5.3.0-14; use reporter/created/labels filters for such lookups.',
      inputSchema: z.object({
        jql: z.string().describe("JQL query"),
        startAt: z.number().int().min(0).optional().default(0),
        maxResults: z.number().int().positive().max(200).optional().default(50),
        fields: z.array(z.string()).optional().describe("Fields to include"),
      }),
      annotations: READ,
    },
    (async ({ jql, startAt, maxResults, fields }: { jql: string; startAt: number; maxResults: number; fields?: string[] }) => {
      const r = await client.searchIssues(jql, startAt, maxResults, fields);
      const result = passthrough(r);
      result.content.push(...r.issues.slice(0, 20).map((i) => ({ type: "resource_link" as const, uri: `jira://issue/${i.key}`, name: i.key, title: i.fields.summary, mimeType: "application/json" })));
      return result;
    }) as never
  );

  tool(
    "jira_delete_issue",
    { title: "Delete Jira issue", description: "Permanently delete an issue. Irreversible; confirm with the user first.", inputSchema: z.object({ issueKey }), annotations: DESTROY },
    (async ({ issueKey: k }: { issueKey: string }, ctx: ServerContext) =>
      withFlow(ctx, async (flow) => {
        if (flow) {
          const answer = await flow.choose({
            key: "confirm-delete",
            message: `Permanently delete ${k}? This cannot be undone.`,
            label: "Confirm",
            options: [{ value: "no", title: "No, keep it" }, { value: "yes", title: `Yes, delete ${k}` }],
          });
          if (answer === PENDING) return fail(`Waiting for confirmation to delete ${k}.`);
          if (answer !== "yes") return fail(`Deletion of ${k} was not confirmed; nothing was deleted.`);
        }
        await client.deleteIssue(k);
        return ok({ issueKey: k, deleted: true });
      })) as never
  );

  tool(
    "jira_assign_issue",
    { title: "Assign Jira issue", description: "Assign an issue to a user, or unassign with null.", inputSchema: z.object({ issueKey, assignee: z.string().nullable().describe("Username (null to unassign)") }), annotations: EDIT },
    (async ({ issueKey: k, assignee }: { issueKey: string; assignee: string | null }) => {
      await client.assignIssue(k, assignee);
      return ok({ issueKey: k, assignee }, [{ key: k }]);
    }) as never
  );

  readTool("jira_get_comments", "Get comments", "Get comments on an issue.", { issueKey }, ({ issueKey: k }) => client.getComments(k));

  tool(
    "jira_add_comment",
    { title: "Add comment", description: "Add a comment to an issue.", inputSchema: z.object({ issueKey, body: z.string().describe("Comment text") }), annotations: CREATE },
    (async ({ issueKey: k, body }: { issueKey: string; body: string }) => passthrough(await client.addComment(k, body))) as never
  );

  readTool("jira_get_transitions", "Get transitions", "Available transitions for an issue, including the fields each transition screen requires (e.g. resolution, assignee) and their allowed values.", { issueKey }, ({ issueKey: k }) => client.getTransitions(k));
  readTool("jira_get_projects", "List projects", "List all visible projects.", {}, () => client.getProjects());
  readTool("jira_get_project", "Get project", "Get project details.", { projectKey: z.string() }, ({ projectKey }) => client.getProject(projectKey));
  readTool("jira_get_project_versions", "Get project versions", "Versions of a project (valid fixVersions/affectsVersions values).", { projectKey: z.string() }, ({ projectKey }) => client.getProjectVersions(projectKey));
  readTool("jira_get_project_components", "Get project components", "Components of a project.", { projectKey: z.string() }, ({ projectKey }) => client.getProjectComponents(projectKey));
  readTool("jira_search_users", "Search users", "Search users by username/name.", { query: z.string() }, ({ query }) => client.searchUsers(query));
  readTool("jira_get_current_user", "Get current user", "The authenticated user.", {}, () => client.getCurrentUser());
  readTool("jira_get_priorities", "Get priorities", "All priorities.", {}, () => client.getPriorities());
  readTool("jira_get_statuses", "Get statuses", "All statuses.", {}, () => client.getStatuses());
  readTool("jira_get_fields", "Get fields", "All fields including custom fields (id, name, type).", {}, () => client.getFields());
  readTool("jira_get_issue_link_types", "Get link types", "All issue link types.", {}, () => client.getIssueLinkTypes());

  tool(
    "jira_link_issues",
    {
      title: "Link issues",
      description: "Link two issues.",
      inputSchema: z.object({ inwardIssue: z.string(), outwardIssue: z.string(), linkType: z.string().describe("Link type name, e.g. Blocks, Relates") }),
      annotations: CREATE,
    },
    (async (a: { inwardIssue: string; outwardIssue: string; linkType: string }) => {
      await client.linkIssues(a.inwardIssue, a.outwardIssue, a.linkType);
      return ok({ linked: true, ...a });
    }) as never
  );

  tool(
    "jira_add_watcher",
    { title: "Add watcher", description: "Add a watcher to an issue.", inputSchema: z.object({ issueKey, username: z.string() }), annotations: EDIT },
    (async (a: { issueKey: string; username: string }) => {
      await client.addWatcher(a.issueKey, a.username);
      return ok({ watching: true, ...a });
    }) as never
  );

  tool(
    "jira_report_issue",
    {
      title: "Prepare a GitHub issue report",
      description:
        "Use when a tool keeps failing with the same error or hits something the AI cannot work around. Builds a redacted GitHub issue draft (no tokens, hostnames, emails, ticket keys or quoted values) and a prefilled link. Nothing is filed automatically: show the draft to the user and let them review and submit it.",
      inputSchema: z.object({
        tool: z.string().describe("Name of the tool that failed, e.g. jira_create_issue"),
        problem: z.string().describe("What was attempted and what went wrong, in one or two sentences"),
        errorMessage: z.string().optional().describe("The error text returned by the tool"),
      }),
      annotations: READ,
    },
    (async (a: { tool: string; problem: string; errorMessage?: string }) => {
      const info = await client.getServerInfo().catch(() => undefined);
      const draft = buildReport({ bugsUrl, serverVersion: version, jiraVersion: info?.version, hosts: [new URL(baseUrl).hostname], ...a });
      return ok({
        filed: false,
        issueUrl: draft.url,
        title: draft.title,
        body: draft.body,
        next: "Show this draft to the user. It is redacted but they should review it for internal details, then open issueUrl to submit it.",
      });
    }) as never
  );

  // ---------- resources ----------

  const asJson = (uri: URL | string, data: unknown) => ({
    contents: [{ uri: typeof uri === "string" ? uri : uri.href, mimeType: "application/json", text: JSON.stringify(data, null, 2) }],
  });

  const staticResource = (name: string, uri: string, title: string, description: string, load: () => Promise<unknown>, cacheHint: { ttlMs: number; cacheScope: "public" | "private" } = STATIC_META) =>
    mcp.registerResource(name, uri, { title, description, mimeType: "application/json", cacheHint }, async (u) => asJson(u, await load()));

  staticResource("current-user", "jira://current-user", "Current user", "The authenticated Jira user", () => client.getCurrentUser());
  staticResource("priorities", "jira://priorities", "Priorities", "All issue priorities", () => client.getPriorities());
  staticResource("statuses", "jira://statuses", "Statuses", "All issue statuses", () => client.getStatuses());
  staticResource("link-types", "jira://link-types", "Link types", "All issue link types", () => client.getIssueLinkTypes());
  staticResource("projects", "jira://projects", "Projects", "All visible projects (key, name, type)", async () =>
    (await client.getProjects()).map((p) => ({ key: p.key, name: p.name, projectTypeKey: p.projectTypeKey })));
  staticResource("fields", "jira://fields", "Fields", "All fields grouped into system and custom", async () => {
    const fields = await client.getFields();
    return { system: fields.filter((f) => !f.custom), custom: fields.filter((f) => f.custom) };
  });
  staticResource("my-issues", "jira://my-issues", "My issues", "Open issues assigned to the current user", async () => {
    const r = await client.searchIssues("assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC", 0, 50);
    return { total: r.total, issues: r.issues.map((i) => ({ key: i.key, summary: i.fields.summary, status: i.fields.status?.name, priority: i.fields.priority?.name, updated: i.fields.updated })) };
  }, { ttlMs: 0, cacheScope: "private" });

  mcp.registerResource(
    "project",
    new ResourceTemplate("jira://project/{key}", {
      list: async () => ({ resources: (await projectKeys()).slice(0, 20).map((p) => ({ uri: `jira://project/${p.key}`, name: `Project: ${p.key}`, description: p.name, mimeType: "application/json" })) }),
      complete: { key: completeProject },
    }),
    { title: "Project", description: "Project details with versions, components and issue types", mimeType: "application/json", cacheHint: STATIC_META },
    async (uri, { key }) => {
      const k = String(key);
      const [project, versions, components, issueTypes] = await Promise.all([
        client.getProject(k), client.getProjectVersions(k), client.getProjectComponents(k), client.getCreateMetaIssueTypes(k),
      ]);
      return asJson(uri, {
        key: project.key,
        name: project.name,
        lead: project.lead,
        versions: versions.map((v) => ({ name: v.name, released: v.released, archived: v.archived })),
        components: components.map((c) => ({ name: c.name, description: c.description })),
        issueTypes: issueTypes.values.map((t) => ({ id: t.id, name: t.name, subtask: t.subtask })),
      });
    }
  );

  mcp.registerResource(
    "issue",
    new ResourceTemplate("jira://issue/{key}", { list: undefined }),
    { title: "Issue", description: "A Jira issue by key", mimeType: "application/json" },
    async (uri, { key }) => asJson(uri, await client.getIssue(String(key)))
  );

  mcp.registerResource(
    "create-fields",
    new ResourceTemplate("jira://project/{key}/fields/{issueType}", {
      list: undefined,
      complete: {
        key: completeProject,
        issueType: async (value, context) => {
          const key = context?.arguments?.key;
          if (!key) return [];
          try {
            const types = await client.getCreateMetaIssueTypes(key);
            return types.values.map((t) => t.name).filter((n) => n.toLowerCase().includes(value.toLowerCase()));
          } catch {
            return [];
          }
        },
      },
    }),
    { title: "Create fields", description: "Fields, required flags and selectable options for creating an issue type in a project", mimeType: "application/json", cacheHint: STATIC_META },
    async (uri, { key, issueType }) => asJson(uri, await client.getCreateMeta(String(key), decodeURIComponent(String(issueType))))
  );

  // ---------- prompts ----------

  const userPrompt = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });

  mcp.registerPrompt(
    "create-ticket",
    {
      title: "Create a Jira ticket",
      description: "Guided ticket creation with validated field values",
      argsSchema: z.object({
        project: completable(z.string().describe("Project key or name"), completeProject),
        summary: z.string().describe("Ticket summary"),
        details: z.string().optional().describe("Any extra details or field values"),
      }),
    },
    ({ project, summary, details }) =>
      userPrompt(
        `Create a Jira ticket in project "${project}" with summary "${summary}".${details ? ` Details: ${details}` : ""}\n` +
          "Steps: 1) If the project is uncertain use jira_find_project. 2) Call jira_create_issue_advanced with dryRun=true. 3) If anything is ambiguous or missing, ask me using the options returned. 4) Only then create it, and report the final key and project."
      )
  );

  mcp.registerPrompt(
    "close-ticket",
    {
      title: "Close or resolve a Jira ticket",
      description: "Transition a ticket, supplying the resolution and comment its workflow requires",
      argsSchema: z.object({ issueKey: z.string().describe("Issue key"), resolution: z.string().optional().describe("Resolution, e.g. Fixed") }),
    },
    ({ issueKey: k, resolution }) =>
      userPrompt(
        `Close ${k}${resolution ? ` with resolution "${resolution}"` : ""}. First call jira_get_transitions for ${k} to see the available transitions and required fields, then call jira_transition_issue with the needed fields and a short comment. Ask me if a required value is unclear.`
      )
  );

  mcp.registerPrompt(
    "my-work-summary",
    { title: "Summarize my open work", description: "Summarize issues assigned to me, grouped by priority" },
    () => userPrompt("Read jira://my-issues and summarize my open issues grouped by priority, highlighting anything stale or blocked.")
  );

  return mcp;
}
