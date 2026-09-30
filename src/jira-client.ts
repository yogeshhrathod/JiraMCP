import { requestSignal } from "./request-context.js";
import type {
  JiraConfig,
  JiraIssue,
  JiraProject,
  JiraComment,
  JiraTransition,
  JiraSearchResult,
  JiraUser,
  JiraCreateIssueRequest,
  JiraCreateIssueResponse,
  JiraUpdateIssueRequest,
  CreateMetaResult,
  FieldMeta,
  FieldOption,
  RawFieldMeta,
} from "./types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Jira returned an HTTP error response. The request was received and
 * rejected, so it is safe to report failure and (for reads) retry.
 */
export class JiraApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "JiraApiError";
  }
}

/**
 * The request failed before a response was received (network error,
 * timeout, aborted connection). For write operations the outcome is
 * ambiguous: Jira may have committed the change anyway.
 */
export class JiraConnectionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "JiraConnectionError";
  }
}

export class JiraClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private requestTimeoutMs: number;

  constructor(config: JiraConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.requestTimeoutMs =
      config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.headers = {
      Authorization: `Bearer ${config.pat}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}/rest/api/2${endpoint}`;

    const controller = new AbortController();
    const timeout = setTimeout(
      () =>
        controller.abort(
          new Error(
            `Jira request timed out after ${this.requestTimeoutMs}ms`
          )
        ),
      this.requestTimeoutMs
    );
    const callerSignal = options.signal ?? requestSignal.getStore();
    if (callerSignal) {
      if (callerSignal.aborted) {
        controller.abort(callerSignal.reason);
      } else {
        callerSignal.addEventListener(
          "abort",
          () => controller.abort(callerSignal.reason),
          { once: true }
        );
      }
    }

    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          ...this.headers,
          ...options.headers,
        },
      });
    } catch (error) {
      throw new JiraConnectionError(
        `Jira request to ${endpoint} failed before a response was received: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new JiraApiError(
        response.status,
        `Jira API error (${response.status}): ${errorText}`
      );
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  // Issue operations
  async getIssue(issueKey: string, expand?: string[]): Promise<JiraIssue> {
    const params = expand ? `?expand=${expand.join(",")}` : "";
    return this.request<JiraIssue>(`/issue/${issueKey}${params}`);
  }

  async createIssue(
    data: JiraCreateIssueRequest
  ): Promise<JiraCreateIssueResponse> {
    return this.request<JiraCreateIssueResponse>("/issue", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  /**
   * Create an issue with recovery from ambiguous failures.
   *
   * If the POST fails at the connection level (timeout, dropped
   * connection, abort), the issue may still have been created on the
   * server. Before reporting failure, search for an issue with the same
   * summary created in the last few minutes by the current user and
   * return it marked as recovered.
   */
  async createIssueWithRecovery(
    fields: Record<string, unknown>
  ): Promise<JiraCreateIssueResponse & { recovered: boolean }> {
    try {
      const created = await this.request<JiraCreateIssueResponse>("/issue", {
        method: "POST",
        body: JSON.stringify({ fields }),
      });
      return { ...created, recovered: false };
    } catch (error) {
      if (!(error instanceof JiraConnectionError)) {
        throw error;
      }
      const summary =
        typeof fields.summary === "string" ? fields.summary : undefined;
      // Recovery must run even when the original request was cancelled.
      const recovered = summary
        ? await requestSignal.run(undefined, () => this.findRecentlyCreatedIssue(summary)).catch(() => undefined)
        : undefined;
      if (recovered) {
        return {
          id: recovered.id,
          key: recovered.key,
          self: recovered.self,
          recovered: true,
        };
      }
      throw new JiraConnectionError(
        `${error.message} The create may or may not have succeeded on the ` +
          `server; no matching recently-created issue was found. ` +
          `Check Jira before retrying to avoid duplicates.`,
        { cause: error }
      );
    }
  }

  /**
   * Find an issue with the exact summary created by the current user in
   * the last few minutes. Uses reporter+created JQL instead of a text
   * search because Jira's ~ operator does not reliably match
   * version-like summaries (e.g. "5.3.0-14").
   */
  private async findRecentlyCreatedIssue(
    summary: string
  ): Promise<JiraIssue | undefined> {
    const results = await this.searchIssues(
      "reporter = currentUser() AND created >= -15m ORDER BY created DESC",
      0,
      20,
      ["summary", "project", "created", "issuetype", "status"]
    );
    const match = results.issues.find((i) => i.fields.summary === summary);
    if (!match) {
      return undefined;
    }
    // Re-fetch so the returned key/project reflect any post-create move.
    return this.getIssue(match.key);
  }

  /**
   * Fetch an issue after creation so the returned key and project reflect
   * any server-side automation (e.g. move to a different project).
   */
  async getCreatedIssue(key: string): Promise<JiraIssue> {
    return this.getIssue(key, ["changelog"]);
  }

  async updateIssue(
    issueKey: string,
    data: JiraUpdateIssueRequest
  ): Promise<void> {
    await this.request<void>(`/issue/${issueKey}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  async deleteIssue(issueKey: string): Promise<void> {
    await this.request<void>(`/issue/${issueKey}`, {
      method: "DELETE",
    });
  }

  async assignIssue(issueKey: string, username: string | null): Promise<void> {
    await this.request<void>(`/issue/${issueKey}/assignee`, {
      method: "PUT",
      body: JSON.stringify({ name: username }),
    });
  }

  // Search
  async searchIssues(
    jql: string,
    startAt = 0,
    maxResults = 50,
    fields?: string[]
  ): Promise<JiraSearchResult> {
    return this.request<JiraSearchResult>("/search", {
      method: "POST",
      body: JSON.stringify({
        jql,
        startAt,
        maxResults,
        fields: fields || [
          "summary",
          "status",
          "assignee",
          "reporter",
          "priority",
          "created",
          "updated",
          "issuetype",
          "project",
          "description",
          "labels",
          "components",
        ],
      }),
    });
  }

  // Projects
  async getProjects(): Promise<JiraProject[]> {
    return this.request<JiraProject[]>("/project");
  }

  async getProject(projectKey: string): Promise<JiraProject> {
    return this.request<JiraProject>(`/project/${projectKey}`);
  }

  // Comments
  async getComments(
    issueKey: string
  ): Promise<{ comments: JiraComment[]; total: number }> {
    return this.request<{ comments: JiraComment[]; total: number }>(
      `/issue/${issueKey}/comment`
    );
  }

  async addComment(issueKey: string, body: string): Promise<JiraComment> {
    return this.request<JiraComment>(`/issue/${issueKey}/comment`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  async updateComment(
    issueKey: string,
    commentId: string,
    body: string
  ): Promise<JiraComment> {
    return this.request<JiraComment>(
      `/issue/${issueKey}/comment/${commentId}`,
      {
        method: "PUT",
        body: JSON.stringify({ body }),
      }
    );
  }

  async deleteComment(issueKey: string, commentId: string): Promise<void> {
    await this.request<void>(`/issue/${issueKey}/comment/${commentId}`, {
      method: "DELETE",
    });
  }

  // Transitions
  async getTransitions(
    issueKey: string
  ): Promise<{ transitions: JiraTransition[] }> {
    return this.request<{ transitions: JiraTransition[] }>(
      `/issue/${issueKey}/transitions?expand=transitions.fields`
    );
  }

  async transitionIssue(
    issueKey: string,
    transitionId: string,
    comment?: string,
    fields?: Record<string, unknown>
  ): Promise<void> {
    const body: {
      transition: { id: string };
      update?: { comment: Array<{ add: { body: string } }> };
      fields?: Record<string, unknown>;
    } = {
      transition: { id: transitionId },
    };
    if (comment) {
      body.update = {
        comment: [{ add: { body: comment } }],
      };
    }
    if (fields) {
      // Transition-screen fields, e.g. { resolution: { name: "Fixed" } }
      body.fields = fields;
    }
    await this.request<void>(`/issue/${issueKey}/transitions`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  // Users
  async searchUsers(query: string): Promise<JiraUser[]> {
    return this.request<JiraUser[]>(
      `/user/search?username=${encodeURIComponent(query)}`
    );
  }

  async getServerInfo(): Promise<{ version?: string; deploymentType?: string }> {
    return this.request<{ version?: string; deploymentType?: string }>("/serverInfo");
  }

  async getCurrentUser(): Promise<JiraUser> {
    return this.request<JiraUser>("/myself");
  }

  // Watchers
  async addWatcher(issueKey: string, username: string): Promise<void> {
    await this.request<void>(`/issue/${issueKey}/watchers`, {
      method: "POST",
      body: JSON.stringify(username),
    });
  }

  async removeWatcher(issueKey: string, username: string): Promise<void> {
    await this.request<void>(
      `/issue/${issueKey}/watchers?username=${encodeURIComponent(username)}`,
      {
        method: "DELETE",
      }
    );
  }

  // Link issues
  async linkIssues(
    inwardIssue: string,
    outwardIssue: string,
    linkType: string
  ): Promise<void> {
    await this.request<void>("/issueLink", {
      method: "POST",
      body: JSON.stringify({
        type: { name: linkType },
        inwardIssue: { key: inwardIssue },
        outwardIssue: { key: outwardIssue },
      }),
    });
  }

  // Get issue types for a project
  async getIssueTypesForProject(
    projectKey: string
  ): Promise<Array<{ id: string; name: string; description: string }>> {
    const project = await this.request<{
      issueTypes: Array<{ id: string; name: string; description: string }>;
    }>(`/project/${projectKey}`);
    return project.issueTypes || [];
  }

  // Get priorities
  async getPriorities(): Promise<Array<{ id: string; name: string }>> {
    return this.request<Array<{ id: string; name: string }>>("/priority");
  }

  // Get statuses
  async getStatuses(): Promise<Array<{ id: string; name: string }>> {
    return this.request<Array<{ id: string; name: string }>>("/status");
  }

  // Get issue types available for a project (for create)
  async getCreateMetaIssueTypes(projectKey: string): Promise<{
    values: Array<{
      id: string;
      name: string;
      description: string;
      subtask: boolean;
    }>;
    total: number;
  }> {
    try {
      return await this.request<{
        values: Array<{
          id: string;
          name: string;
          description: string;
          subtask: boolean;
        }>;
        total: number;
      }>(
        `/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes?maxResults=100`
      );
    } catch (error) {
      if (error instanceof JiraConnectionError) {
        throw error;
      }
      // Some Jira Server/DC versions reject the paged createmeta endpoint.
      // Fall back to the issue types listed on the project resource.
      const project = await this.request<{
        issueTypes?: Array<{
          id: string;
          name: string;
          description?: string;
          subtask?: boolean;
        }>;
      }>(`/project/${encodeURIComponent(projectKey)}`);
      const values = (project.issueTypes || []).map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description || "",
        subtask: t.subtask || false,
      }));
      return { values, total: values.length };
    }
  }

  normalizeFields(
    raw: Record<string, RawFieldMeta> | Array<RawFieldMeta> | undefined
  ): FieldMeta[] {
    if (!raw) {
      return [];
    }
    const entries: Array<[string | undefined, RawFieldMeta]> = Array.isArray(raw)
      ? raw.map((f) => [f.fieldId ?? f.key, f])
      : Object.entries(raw);
    return entries
      .filter(([id]) => !!id)
      .map(([id, f]) => ({
        fieldId: id as string,
        name: f.name,
        required: !!f.required,
        schema: f.schema,
        hasDefaultValue: f.hasDefaultValue ?? f.defaultValue !== undefined,
        hasAllowedValues: !!f.allowedValues,
        allowedValues: f.allowedValues as FieldOption[] | undefined,
      }));
  }

  // Get fields for a specific project and issue type (for create)
  async getCreateMetaFields(
    projectKey: string,
    issueTypeId: string
  ): Promise<{ values: RawFieldMeta[]; total: number }> {
    return this.request<{ values: RawFieldMeta[]; total: number }>(
      `/issue/createmeta/${encodeURIComponent(
        projectKey
      )}/issuetypes/${encodeURIComponent(issueTypeId)}?maxResults=100`
    );
  }

  // Get create metadata - combines issue types and fields info.
  // Tries multiple endpoints because Jira Server/DC versions differ in
  // which createmeta endpoints they support.
  async getCreateMeta(
    projectKey: string,
    issueTypeName?: string
  ): Promise<CreateMetaResult> {
    const errors: string[] = [];
    const strategies: Array<[string, () => Promise<CreateMetaResult>]> = [
      ["paged createmeta", () => this.getCreateMetaPaged(projectKey, issueTypeName)],
      ["legacy createmeta", () => this.getCreateMetaLegacy(projectKey, issueTypeName)],
      ["editmeta fallback", () => this.getCreateMetaFromEditMeta(projectKey, issueTypeName)],
    ];

    for (const [label, run] of strategies) {
      try {
        return await run();
      } catch (error) {
        if (error instanceof JiraConnectionError) {
          throw error;
        }
        errors.push(`${label}: ${(error as Error).message}`);
      }
    }

    throw new Error(
      `Unable to get create metadata for project ${projectKey}. ` +
        errors.join(" | ")
    );
  }

  private async getCreateMetaPaged(
    projectKey: string,
    issueTypeName?: string
  ): Promise<CreateMetaResult> {
    const { values: issueTypes } = await this.getCreateMetaIssueTypes(projectKey);
    const filteredTypes = issueTypeName
      ? issueTypes.filter(
          (t) => t.name.toLowerCase() === issueTypeName.toLowerCase()
        )
      : issueTypes;

    return {
      projectKey,
      metaSource: "createmeta-paged",
      accurate: true,
      issueTypes: await Promise.all(
        filteredTypes.map(async (issueType) => ({
          id: issueType.id,
          name: issueType.name,
          fields: this.normalizeFields(
            (await this.getCreateMetaFields(projectKey, issueType.id)).values
          ),
        }))
      ),
    };
  }

  // Legacy createmeta endpoint: GET /issue/createmeta?projectKeys=...
  private async getCreateMetaLegacy(
    projectKey: string,
    issueTypeName?: string
  ): Promise<CreateMetaResult> {
    const params =
      `?projectKeys=${encodeURIComponent(projectKey)}` +
      `&expand=projects.issuetypes.fields` +
      (issueTypeName
        ? `&issuetypeNames=${encodeURIComponent(issueTypeName)}`
        : "");
    const data = await this.request<{
      projects: Array<{
        issuetypes: Array<{
          id: string;
          name: string;
          fields?: Record<string, RawFieldMeta>;
        }>;
      }>;
    }>(`/issue/createmeta${params}`);

    const project = data.projects?.[0];
    if (!project) {
      throw new Error(`Project ${projectKey} not found in createmeta`);
    }

    return {
      projectKey,
      metaSource: "createmeta-legacy",
      accurate: true,
      issueTypes: project.issuetypes.map((it) => ({
        id: it.id,
        name: it.name,
        fields: this.normalizeFields(it.fields),
      })),
    };
  }

  // Last resort: editmeta of a recent issue of the same type in the project.
  // Shows editable fields and their allowed values, not the create screen, so
  // "required" flags are not authoritative.
  private async getCreateMetaFromEditMeta(
    projectKey: string,
    issueTypeName?: string
  ): Promise<CreateMetaResult> {
    const quote = (v: string) => `"${v.replace(/(["\\])/g, "\\$1")}"`;
    const jql =
      `project = ${quote(projectKey)}` +
      (issueTypeName ? ` AND issuetype = ${quote(issueTypeName)}` : "") +
      ` ORDER BY created DESC`;
    const search = await this.searchIssues(jql, 0, 1, ["issuetype", "summary"]);
    const ref = search.issues[0];
    if (!ref) {
      throw new Error(
        `No reference issue found in project ${projectKey}` +
          (issueTypeName ? ` with type ${issueTypeName}` : "")
      );
    }

    const editMeta = (await this.getEditMeta(ref.key)) as {
      fields?: Record<string, RawFieldMeta>;
    };

    return {
      projectKey,
      metaSource: `editmeta of ${ref.key}`,
      accurate: false,
      issueTypes: [
        {
          id: ref.fields.issuetype.id,
          name: ref.fields.issuetype.name,
          fields: this.normalizeFields(editMeta.fields),
        },
      ],
    };
  }

  // Edit metadata for an existing issue, normalized.
  async getEditFieldMeta(issueKey: string): Promise<FieldMeta[]> {
    const meta = (await this.getEditMeta(issueKey)) as {
      fields?: Record<string, RawFieldMeta>;
    };
    return this.normalizeFields(meta.fields);
  }

  // Get edit metadata - shows editable fields and allowed values for an existing issue
  async getEditMeta(issueKey: string): Promise<unknown> {
    return this.request<unknown>(`/issue/${issueKey}/editmeta`);
  }

  // Get project versions (for fixVersions field)
  async getProjectVersions(
    projectKey: string
  ): Promise<
    Array<{ id: string; name: string; released: boolean; archived: boolean }>
  > {
    return this.request<
      Array<{ id: string; name: string; released: boolean; archived: boolean }>
    >(`/project/${projectKey}/versions`);
  }

  // Get project components
  async getProjectComponents(
    projectKey: string
  ): Promise<Array<{ id: string; name: string; description?: string }>> {
    return this.request<
      Array<{ id: string; name: string; description?: string }>
    >(`/project/${projectKey}/components`);
  }

  // Get all fields (including custom fields)
  async getFields(): Promise<
    Array<{
      id: string;
      name: string;
      custom: boolean;
      schema?: { type: string };
    }>
  > {
    return this.request<
      Array<{
        id: string;
        name: string;
        custom: boolean;
        schema?: { type: string };
      }>
    >("/field");
  }

  // Get issue link types
  async getIssueLinkTypes(): Promise<{
    issueLinkTypes: Array<{
      id: string;
      name: string;
      inward: string;
      outward: string;
    }>;
  }> {
    return this.request<{
      issueLinkTypes: Array<{
        id: string;
        name: string;
        inward: string;
        outward: string;
      }>;
    }>("/issueLinkType");
  }

  // Create issue with raw fields (supports all fields including custom)
  async createIssueRaw(
    fields: Record<string, unknown>
  ): Promise<JiraCreateIssueResponse> {
    return this.request<JiraCreateIssueResponse>("/issue", {
      method: "POST",
      body: JSON.stringify({ fields }),
    });
  }

  // Update issue with raw fields (supports all fields including custom)
  async updateIssueRaw(
    issueKey: string,
    fields: Record<string, unknown>
  ): Promise<void> {
    await this.request<void>(`/issue/${issueKey}`, {
      method: "PUT",
      body: JSON.stringify({ fields }),
    });
  }
}
