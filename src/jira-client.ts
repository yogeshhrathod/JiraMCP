import type {
  JiraConfig,
  JiraIssue,
  JiraProject,
  JiraComment,
  JiraTransition,
  JiraSearchResult,
  JiraUser,
  JiraCreateIssueRequest,
  JiraUpdateIssueRequest,
} from "./types.js";

export class JiraClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: JiraConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
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
    const response = await fetch(url, {
      ...options,
      headers: {
        ...this.headers,
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Jira API error (${response.status}): ${errorText}`);
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

  async createIssue(data: JiraCreateIssueRequest): Promise<JiraIssue> {
    return this.request<JiraIssue>("/issue", {
      method: "POST",
      body: JSON.stringify(data),
    });
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
      `/issue/${issueKey}/transitions`
    );
  }

  async transitionIssue(
    issueKey: string,
    transitionId: string,
    comment?: string
  ): Promise<void> {
    const body: {
      transition: { id: string };
      update?: { comment: Array<{ add: { body: string } }> };
    } = {
      transition: { id: transitionId },
    };
    if (comment) {
      body.update = {
        comment: [{ add: { body: comment } }],
      };
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
    return this.request<{
      values: Array<{
        id: string;
        name: string;
        description: string;
        subtask: boolean;
      }>;
      total: number;
    }>(`/issue/createmeta/${projectKey}/issuetypes`);
  }

  // Get fields for a specific project and issue type (for create)
  async getCreateMetaFields(
    projectKey: string,
    issueTypeId: string
  ): Promise<{
    values: Array<{
      fieldId: string;
      name: string;
      required: boolean;
      allowedValues?: Array<{ id: string; name: string; value?: string }>;
      schema: { type: string; system?: string; custom?: string };
      defaultValue?: unknown;
    }>;
    total: number;
  }> {
    return this.request<{
      values: Array<{
        fieldId: string;
        name: string;
        required: boolean;
        allowedValues?: Array<{ id: string; name: string; value?: string }>;
        schema: { type: string; system?: string; custom?: string };
        defaultValue?: unknown;
      }>;
      total: number;
    }>(
      `/issue/createmeta/${projectKey}/issuetypes/${issueTypeId}?maxResults=100`
    );
  }

  // Get create metadata - combines issue types and fields info
  async getCreateMeta(
    projectKey: string,
    issueTypeName?: string
  ): Promise<{
    projectKey: string;
    issueTypes: Array<{
      id: string;
      name: string;
      fields?: Array<{
        fieldId: string;
        name: string;
        required: boolean;
        hasAllowedValues: boolean;
        allowedValues?: Array<{ id: string; name: string; value?: string }>;
      }>;
    }>;
  }> {
    const issueTypesResult = await this.getCreateMetaIssueTypes(projectKey);
    const issueTypes = issueTypesResult.values;

    // Filter by issue type name if provided
    const filteredTypes = issueTypeName
      ? issueTypes.filter(
          (t) => t.name.toLowerCase() === issueTypeName.toLowerCase()
        )
      : issueTypes;

    // Get fields for each issue type
    const result = {
      projectKey,
      issueTypes: await Promise.all(
        filteredTypes.map(async (issueType) => {
          const fieldsResult = await this.getCreateMetaFields(
            projectKey,
            issueType.id
          );
          return {
            id: issueType.id,
            name: issueType.name,
            fields: fieldsResult.values.map((f) => ({
              fieldId: f.fieldId,
              name: f.name,
              required: f.required,
              hasAllowedValues: !!f.allowedValues,
              allowedValues: f.allowedValues,
            })),
          };
        })
      ),
    };

    return result;
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
  async createIssueRaw(fields: Record<string, unknown>): Promise<JiraIssue> {
    return this.request<JiraIssue>("/issue", {
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

  // Get field options for a specific field in a project context
  async getFieldOptions(
    projectKey: string,
    issueTypeName: string,
    fieldKey: string
  ): Promise<unknown> {
    const meta = await this.getCreateMeta(projectKey, issueTypeName);
    const issueType = meta.issueTypes[0];
    if (!issueType?.fields) {
      return [];
    }
    const field = issueType.fields.find((f) => f.fieldId === fieldKey);
    return field?.allowedValues || [];
  }
}
