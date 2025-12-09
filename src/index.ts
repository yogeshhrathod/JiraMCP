#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import dotenv from "dotenv";
import { JiraClient } from "./jira-client.js";

dotenv.config();

// Validate environment variables
const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const PAT = process.env.PAT;

if (!JIRA_BASE_URL || !PAT) {
  console.error(
    "Missing required environment variables: JIRA_BASE_URL and PAT"
  );
  process.exit(1);
}

const jiraClient = new JiraClient({
  baseUrl: JIRA_BASE_URL,
  pat: PAT,
});

// Tool input schemas
const GetIssueSchema = z.object({
  issueKey: z.string().describe("The Jira issue key (e.g., PROJ-123)"),
  expand: z.array(z.string()).optional().describe("Fields to expand"),
});

const SearchIssuesSchema = z.object({
  jql: z.string().describe("JQL query string"),
  startAt: z.number().optional().default(0).describe("Starting index"),
  maxResults: z
    .number()
    .optional()
    .default(50)
    .describe("Maximum results to return"),
  fields: z.array(z.string()).optional().describe("Fields to include"),
});

const CreateIssueSchema = z.object({
  projectKey: z.string().describe("Project key"),
  summary: z.string().describe("Issue summary"),
  issueType: z.string().describe("Issue type (e.g., Bug, Task, Story)"),
  description: z.string().optional().describe("Issue description"),
  priority: z.string().optional().describe("Priority name"),
  assignee: z.string().optional().describe("Assignee username"),
  labels: z.array(z.string()).optional().describe("Labels"),
});

const UpdateIssueSchema = z.object({
  issueKey: z.string().describe("The Jira issue key"),
  summary: z.string().optional().describe("New summary"),
  description: z.string().optional().describe("New description"),
  priority: z.string().optional().describe("New priority name"),
  assignee: z.string().optional().describe("New assignee username"),
  labels: z.array(z.string()).optional().describe("New labels"),
});

const AddCommentSchema = z.object({
  issueKey: z.string().describe("The Jira issue key"),
  body: z.string().describe("Comment body"),
});

const TransitionIssueSchema = z.object({
  issueKey: z.string().describe("The Jira issue key"),
  transitionId: z.string().describe("Transition ID"),
  comment: z.string().optional().describe("Optional comment"),
});

const AssignIssueSchema = z.object({
  issueKey: z.string().describe("The Jira issue key"),
  assignee: z
    .string()
    .nullable()
    .describe("Username to assign (null to unassign)"),
});

const GetCommentsSchema = z.object({
  issueKey: z.string().describe("The Jira issue key"),
});

const GetTransitionsSchema = z.object({
  issueKey: z.string().describe("The Jira issue key"),
});

const DeleteIssueSchema = z.object({
  issueKey: z.string().describe("The Jira issue key to delete"),
});

const GetProjectSchema = z.object({
  projectKey: z.string().describe("The project key"),
});

const SearchUsersSchema = z.object({
  query: z.string().describe("Username search query"),
});

const LinkIssuesSchema = z.object({
  inwardIssue: z.string().describe("Inward issue key"),
  outwardIssue: z.string().describe("Outward issue key"),
  linkType: z.string().describe("Link type name (e.g., 'Blocks', 'Relates')"),
});

const AddWatcherSchema = z.object({
  issueKey: z.string().describe("The Jira issue key"),
  username: z.string().describe("Username to add as watcher"),
});

const GetCreateMetaSchema = z.object({
  projectKey: z.string().describe("Project key to get metadata for"),
  issueType: z
    .string()
    .optional()
    .describe("Issue type name to filter (e.g., Bug, Task, Story)"),
});

const GetEditMetaSchema = z.object({
  issueKey: z.string().describe("The Jira issue key to get edit metadata for"),
});

const GetProjectVersionsSchema = z.object({
  projectKey: z.string().describe("Project key to get versions for"),
});

const GetProjectComponentsSchema = z.object({
  projectKey: z.string().describe("Project key to get components for"),
});

const CreateIssueAdvancedSchema = z.object({
  projectKey: z.string().describe("Project key"),
  summary: z.string().describe("Issue summary"),
  issueType: z.string().describe("Issue type (e.g., Bug, Task, Story)"),
  description: z.string().optional().describe("Issue description"),
  priority: z.string().optional().describe("Priority name"),
  assignee: z.string().optional().describe("Assignee username"),
  reporter: z.string().optional().describe("Reporter username"),
  labels: z.array(z.string()).optional().describe("Labels"),
  components: z.array(z.string()).optional().describe("Component names"),
  fixVersions: z.array(z.string()).optional().describe("Fix version names"),
  affectsVersions: z
    .array(z.string())
    .optional()
    .describe("Affects version names"),
  customFields: z
    .record(z.unknown())
    .optional()
    .describe(
      'Custom fields as key-value pairs (e.g., {"customfield_10001": "value"})'
    ),
});

const UpdateIssueAdvancedSchema = z.object({
  issueKey: z.string().describe("The Jira issue key"),
  summary: z.string().optional().describe("New summary"),
  description: z.string().optional().describe("New description"),
  priority: z.string().optional().describe("New priority name"),
  assignee: z.string().optional().describe("New assignee username"),
  labels: z.array(z.string()).optional().describe("New labels"),
  components: z.array(z.string()).optional().describe("Component names"),
  fixVersions: z.array(z.string()).optional().describe("Fix version names"),
  affectsVersions: z
    .array(z.string())
    .optional()
    .describe("Affects version names"),
  customFields: z
    .record(z.unknown())
    .optional()
    .describe("Custom fields as key-value pairs"),
});

const GetFieldOptionsSchema = z.object({
  projectKey: z.string().describe("Project key"),
  issueType: z.string().describe("Issue type name"),
  fieldKey: z
    .string()
    .describe(
      "Field key (e.g., 'fixVersions', 'components', 'customfield_10001')"
    ),
});

// Create MCP server
const server = new Server(
  {
    name: "jira-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "jira_get_issue",
        description: "Get details of a Jira issue by its key",
        inputSchema: {
          type: "object",
          properties: {
            issueKey: {
              type: "string",
              description: "The Jira issue key (e.g., PROJ-123)",
            },
            expand: {
              type: "array",
              items: { type: "string" },
              description: "Fields to expand",
            },
          },
          required: ["issueKey"],
        },
      },
      {
        name: "jira_search_issues",
        description: "Search for Jira issues using JQL",
        inputSchema: {
          type: "object",
          properties: {
            jql: { type: "string", description: "JQL query string" },
            startAt: { type: "number", description: "Starting index" },
            maxResults: {
              type: "number",
              description: "Maximum results to return",
            },
            fields: {
              type: "array",
              items: { type: "string" },
              description: "Fields to include",
            },
          },
          required: ["jql"],
        },
      },
      {
        name: "jira_create_issue",
        description: "Create a new Jira issue",
        inputSchema: {
          type: "object",
          properties: {
            projectKey: { type: "string", description: "Project key" },
            summary: { type: "string", description: "Issue summary" },
            issueType: {
              type: "string",
              description: "Issue type (e.g., Bug, Task, Story)",
            },
            description: { type: "string", description: "Issue description" },
            priority: { type: "string", description: "Priority name" },
            assignee: { type: "string", description: "Assignee username" },
            labels: {
              type: "array",
              items: { type: "string" },
              description: "Labels",
            },
          },
          required: ["projectKey", "summary", "issueType"],
        },
      },
      {
        name: "jira_update_issue",
        description: "Update an existing Jira issue",
        inputSchema: {
          type: "object",
          properties: {
            issueKey: { type: "string", description: "The Jira issue key" },
            summary: { type: "string", description: "New summary" },
            description: { type: "string", description: "New description" },
            priority: { type: "string", description: "New priority name" },
            assignee: { type: "string", description: "New assignee username" },
            labels: {
              type: "array",
              items: { type: "string" },
              description: "New labels",
            },
          },
          required: ["issueKey"],
        },
      },
      {
        name: "jira_delete_issue",
        description: "Delete a Jira issue",
        inputSchema: {
          type: "object",
          properties: {
            issueKey: {
              type: "string",
              description: "The Jira issue key to delete",
            },
          },
          required: ["issueKey"],
        },
      },
      {
        name: "jira_assign_issue",
        description: "Assign or unassign a Jira issue",
        inputSchema: {
          type: "object",
          properties: {
            issueKey: { type: "string", description: "The Jira issue key" },
            assignee: {
              type: ["string", "null"],
              description: "Username to assign (null to unassign)",
            },
          },
          required: ["issueKey", "assignee"],
        },
      },
      {
        name: "jira_get_comments",
        description: "Get comments on a Jira issue",
        inputSchema: {
          type: "object",
          properties: {
            issueKey: { type: "string", description: "The Jira issue key" },
          },
          required: ["issueKey"],
        },
      },
      {
        name: "jira_add_comment",
        description: "Add a comment to a Jira issue",
        inputSchema: {
          type: "object",
          properties: {
            issueKey: { type: "string", description: "The Jira issue key" },
            body: { type: "string", description: "Comment body" },
          },
          required: ["issueKey", "body"],
        },
      },
      {
        name: "jira_get_transitions",
        description: "Get available transitions for a Jira issue",
        inputSchema: {
          type: "object",
          properties: {
            issueKey: { type: "string", description: "The Jira issue key" },
          },
          required: ["issueKey"],
        },
      },
      {
        name: "jira_transition_issue",
        description: "Transition a Jira issue to a new status",
        inputSchema: {
          type: "object",
          properties: {
            issueKey: { type: "string", description: "The Jira issue key" },
            transitionId: { type: "string", description: "Transition ID" },
            comment: { type: "string", description: "Optional comment" },
          },
          required: ["issueKey", "transitionId"],
        },
      },
      {
        name: "jira_get_projects",
        description: "Get all Jira projects",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "jira_get_project",
        description: "Get details of a specific Jira project",
        inputSchema: {
          type: "object",
          properties: {
            projectKey: { type: "string", description: "The project key" },
          },
          required: ["projectKey"],
        },
      },
      {
        name: "jira_search_users",
        description: "Search for Jira users",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Username search query" },
          },
          required: ["query"],
        },
      },
      {
        name: "jira_get_current_user",
        description: "Get the current authenticated user",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "jira_link_issues",
        description: "Link two Jira issues",
        inputSchema: {
          type: "object",
          properties: {
            inwardIssue: { type: "string", description: "Inward issue key" },
            outwardIssue: { type: "string", description: "Outward issue key" },
            linkType: {
              type: "string",
              description: "Link type name (e.g., 'Blocks', 'Relates')",
            },
          },
          required: ["inwardIssue", "outwardIssue", "linkType"],
        },
      },
      {
        name: "jira_add_watcher",
        description: "Add a watcher to a Jira issue",
        inputSchema: {
          type: "object",
          properties: {
            issueKey: { type: "string", description: "The Jira issue key" },
            username: {
              type: "string",
              description: "Username to add as watcher",
            },
          },
          required: ["issueKey", "username"],
        },
      },
      {
        name: "jira_get_priorities",
        description: "Get all available priorities",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "jira_get_statuses",
        description: "Get all available statuses",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "jira_get_create_meta",
        description:
          "Get metadata for creating issues - shows required fields and allowed values (dropdown options) for a project and issue type. IMPORTANT: Call this before creating an issue to know what fields are required and what values are allowed.",
        inputSchema: {
          type: "object",
          properties: {
            projectKey: {
              type: "string",
              description: "Project key to get metadata for",
            },
            issueType: {
              type: "string",
              description: "Issue type name to filter (e.g., Bug, Task, Story)",
            },
          },
          required: ["projectKey"],
        },
      },
      {
        name: "jira_get_edit_meta",
        description:
          "Get metadata for editing an issue - shows editable fields and allowed values for an existing issue",
        inputSchema: {
          type: "object",
          properties: {
            issueKey: {
              type: "string",
              description: "The Jira issue key to get edit metadata for",
            },
          },
          required: ["issueKey"],
        },
      },
      {
        name: "jira_get_project_versions",
        description:
          "Get all versions for a project - use this to find valid values for fixVersions and affectsVersions fields",
        inputSchema: {
          type: "object",
          properties: {
            projectKey: {
              type: "string",
              description: "Project key to get versions for",
            },
          },
          required: ["projectKey"],
        },
      },
      {
        name: "jira_get_project_components",
        description:
          "Get all components for a project - use this to find valid values for the components field",
        inputSchema: {
          type: "object",
          properties: {
            projectKey: {
              type: "string",
              description: "Project key to get components for",
            },
          },
          required: ["projectKey"],
        },
      },
      {
        name: "jira_get_fields",
        description:
          "Get all available fields including custom fields - shows field IDs, names, and types",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "jira_get_field_options",
        description:
          "Get allowed values/options for a specific field in a project and issue type context",
        inputSchema: {
          type: "object",
          properties: {
            projectKey: { type: "string", description: "Project key" },
            issueType: { type: "string", description: "Issue type name" },
            fieldKey: {
              type: "string",
              description:
                "Field key (e.g., 'fixVersions', 'components', 'customfield_10001')",
            },
          },
          required: ["projectKey", "issueType", "fieldKey"],
        },
      },
      {
        name: "jira_get_issue_link_types",
        description: "Get all available issue link types",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "jira_create_issue_advanced",
        description:
          "Create a new Jira issue with full field support including fixVersions, components, and custom fields. Use jira_get_create_meta first to discover required fields and allowed values.",
        inputSchema: {
          type: "object",
          properties: {
            projectKey: { type: "string", description: "Project key" },
            summary: { type: "string", description: "Issue summary" },
            issueType: {
              type: "string",
              description: "Issue type (e.g., Bug, Task, Story)",
            },
            description: { type: "string", description: "Issue description" },
            priority: { type: "string", description: "Priority name" },
            assignee: { type: "string", description: "Assignee username" },
            reporter: { type: "string", description: "Reporter username" },
            labels: {
              type: "array",
              items: { type: "string" },
              description: "Labels",
            },
            components: {
              type: "array",
              items: { type: "string" },
              description: "Component names",
            },
            fixVersions: {
              type: "array",
              items: { type: "string" },
              description: "Fix version names",
            },
            affectsVersions: {
              type: "array",
              items: { type: "string" },
              description: "Affects version names",
            },
            customFields: {
              type: "object",
              description:
                'Custom fields as key-value pairs (e.g., {"customfield_10001": "value"})',
            },
          },
          required: ["projectKey", "summary", "issueType"],
        },
      },
      {
        name: "jira_update_issue_advanced",
        description:
          "Update a Jira issue with full field support including fixVersions, components, and custom fields. Use jira_get_edit_meta first to discover editable fields and allowed values.",
        inputSchema: {
          type: "object",
          properties: {
            issueKey: { type: "string", description: "The Jira issue key" },
            summary: { type: "string", description: "New summary" },
            description: { type: "string", description: "New description" },
            priority: { type: "string", description: "New priority name" },
            assignee: { type: "string", description: "New assignee username" },
            labels: {
              type: "array",
              items: { type: "string" },
              description: "New labels",
            },
            components: {
              type: "array",
              items: { type: "string" },
              description: "Component names",
            },
            fixVersions: {
              type: "array",
              items: { type: "string" },
              description: "Fix version names",
            },
            affectsVersions: {
              type: "array",
              items: { type: "string" },
              description: "Affects version names",
            },
            customFields: {
              type: "object",
              description: "Custom fields as key-value pairs",
            },
          },
          required: ["issueKey"],
        },
      },
    ],
  };
});

// List available resources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  try {
    // Fetch projects to create dynamic resources
    const projects = await jiraClient.getProjects();
    const currentUser = await jiraClient.getCurrentUser();

    const resources = [
      // Static resources
      {
        uri: "jira://config",
        name: "Jira Configuration",
        description: "Current Jira server configuration and connection info",
        mimeType: "application/json",
      },
      {
        uri: "jira://current-user",
        name: "Current User",
        description: "Currently authenticated Jira user",
        mimeType: "application/json",
      },
      {
        uri: "jira://priorities",
        name: "Priorities",
        description: "All available issue priorities",
        mimeType: "application/json",
      },
      {
        uri: "jira://statuses",
        name: "Statuses",
        description: "All available issue statuses",
        mimeType: "application/json",
      },
      {
        uri: "jira://fields",
        name: "Fields",
        description: "All available fields including custom fields",
        mimeType: "application/json",
      },
      {
        uri: "jira://link-types",
        name: "Issue Link Types",
        description: "All available issue link types",
        mimeType: "application/json",
      },
      {
        uri: "jira://projects",
        name: "All Projects",
        description: `List of all ${projects.length} Jira projects`,
        mimeType: "application/json",
      },
      // Dynamic project resources (top 20 projects)
      ...projects.slice(0, 20).map((project) => ({
        uri: `jira://project/${project.key}`,
        name: `Project: ${project.key}`,
        description: `${project.name} - versions, components, and issue types`,
        mimeType: "application/json",
      })),
      // My issues resource
      {
        uri: `jira://my-issues`,
        name: "My Issues",
        description: `Issues assigned to ${currentUser.displayName}`,
        mimeType: "application/json",
      },
    ];

    return { resources };
  } catch (error) {
    return {
      resources: [
        {
          uri: "jira://config",
          name: "Jira Configuration",
          description: "Current Jira server configuration",
          mimeType: "application/json",
        },
      ],
    };
  }
});

// Read resource content
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  try {
    // Parse the URI
    if (uri === "jira://config") {
      const config = {
        baseUrl: JIRA_BASE_URL,
        serverInfo: "Self-hosted Jira Server",
        authenticated: true,
      };
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(config, null, 2),
          },
        ],
      };
    }

    if (uri === "jira://current-user") {
      const user = await jiraClient.getCurrentUser();
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(user, null, 2),
          },
        ],
      };
    }

    if (uri === "jira://priorities") {
      const priorities = await jiraClient.getPriorities();
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(priorities, null, 2),
          },
        ],
      };
    }

    if (uri === "jira://statuses") {
      const statuses = await jiraClient.getStatuses();
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(statuses, null, 2),
          },
        ],
      };
    }

    if (uri === "jira://fields") {
      const fields = await jiraClient.getFields();
      // Group fields by type for better readability
      const grouped = {
        system: fields.filter((f) => !f.custom),
        custom: fields.filter((f) => f.custom),
      };
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(grouped, null, 2),
          },
        ],
      };
    }

    if (uri === "jira://link-types") {
      const linkTypes = await jiraClient.getIssueLinkTypes();
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(linkTypes, null, 2),
          },
        ],
      };
    }

    if (uri === "jira://projects") {
      const projects = await jiraClient.getProjects();
      const summary = projects.map((p) => ({
        key: p.key,
        name: p.name,
        projectTypeKey: p.projectTypeKey,
      }));
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    }

    if (uri === "jira://my-issues") {
      const results = await jiraClient.searchIssues(
        "assignee = currentUser() ORDER BY updated DESC",
        0,
        50
      );
      const summary = {
        total: results.total,
        issues: results.issues.map((i) => ({
          key: i.key,
          summary: i.fields.summary,
          status: i.fields.status.name,
          priority: i.fields.priority?.name,
          updated: i.fields.updated,
        })),
      };
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    }

    // Handle project-specific resources: jira://project/{key}
    const projectMatch = uri.match(/^jira:\/\/project\/([A-Z0-9]+)$/);
    if (projectMatch) {
      const projectKey = projectMatch[1];
      const [project, versions, components, issueTypes] = await Promise.all([
        jiraClient.getProject(projectKey),
        jiraClient.getProjectVersions(projectKey),
        jiraClient.getProjectComponents(projectKey),
        jiraClient.getCreateMetaIssueTypes(projectKey),
      ]);

      const projectInfo = {
        key: project.key,
        name: project.name,
        lead: project.lead,
        versions: versions.map((v) => ({
          name: v.name,
          released: v.released,
          archived: v.archived,
        })),
        components: components.map((c) => ({
          name: c.name,
          description: c.description,
        })),
        issueTypes: issueTypes.values.map((t) => ({
          id: t.id,
          name: t.name,
          subtask: t.subtask,
        })),
      };

      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(projectInfo, null, 2),
          },
        ],
      };
    }

    throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${uri}`);
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Error reading resource ${uri}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "jira_get_issue": {
        const { issueKey, expand } = GetIssueSchema.parse(args);
        const issue = await jiraClient.getIssue(issueKey, expand);
        return {
          content: [{ type: "text", text: JSON.stringify(issue, null, 2) }],
        };
      }

      case "jira_search_issues": {
        const { jql, startAt, maxResults, fields } =
          SearchIssuesSchema.parse(args);
        const results = await jiraClient.searchIssues(
          jql,
          startAt,
          maxResults,
          fields
        );
        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        };
      }

      case "jira_create_issue": {
        const {
          projectKey,
          summary,
          issueType,
          description,
          priority,
          assignee,
          labels,
        } = CreateIssueSchema.parse(args);
        const issue = await jiraClient.createIssue({
          fields: {
            project: { key: projectKey },
            summary,
            issuetype: { name: issueType },
            ...(description && { description }),
            ...(priority && { priority: { name: priority } }),
            ...(assignee && { assignee: { name: assignee } }),
            ...(labels && { labels }),
          },
        });
        return {
          content: [{ type: "text", text: JSON.stringify(issue, null, 2) }],
        };
      }

      case "jira_update_issue": {
        const { issueKey, summary, description, priority, assignee, labels } =
          UpdateIssueSchema.parse(args);
        await jiraClient.updateIssue(issueKey, {
          fields: {
            ...(summary && { summary }),
            ...(description && { description }),
            ...(priority && { priority: { name: priority } }),
            ...(assignee && { assignee: { name: assignee } }),
            ...(labels && { labels }),
          },
        });
        return {
          content: [
            { type: "text", text: `Issue ${issueKey} updated successfully` },
          ],
        };
      }

      case "jira_delete_issue": {
        const { issueKey } = DeleteIssueSchema.parse(args);
        await jiraClient.deleteIssue(issueKey);
        return {
          content: [
            { type: "text", text: `Issue ${issueKey} deleted successfully` },
          ],
        };
      }

      case "jira_assign_issue": {
        const { issueKey, assignee } = AssignIssueSchema.parse(args);
        await jiraClient.assignIssue(issueKey, assignee);
        return {
          content: [
            {
              type: "text",
              text: assignee
                ? `Issue ${issueKey} assigned to ${assignee}`
                : `Issue ${issueKey} unassigned`,
            },
          ],
        };
      }

      case "jira_get_comments": {
        const { issueKey } = GetCommentsSchema.parse(args);
        const comments = await jiraClient.getComments(issueKey);
        return {
          content: [{ type: "text", text: JSON.stringify(comments, null, 2) }],
        };
      }

      case "jira_add_comment": {
        const { issueKey, body } = AddCommentSchema.parse(args);
        const comment = await jiraClient.addComment(issueKey, body);
        return {
          content: [{ type: "text", text: JSON.stringify(comment, null, 2) }],
        };
      }

      case "jira_get_transitions": {
        const { issueKey } = GetTransitionsSchema.parse(args);
        const transitions = await jiraClient.getTransitions(issueKey);
        return {
          content: [
            { type: "text", text: JSON.stringify(transitions, null, 2) },
          ],
        };
      }

      case "jira_transition_issue": {
        const { issueKey, transitionId, comment } =
          TransitionIssueSchema.parse(args);
        await jiraClient.transitionIssue(issueKey, transitionId, comment);
        return {
          content: [
            {
              type: "text",
              text: `Issue ${issueKey} transitioned successfully`,
            },
          ],
        };
      }

      case "jira_get_projects": {
        const projects = await jiraClient.getProjects();
        return {
          content: [{ type: "text", text: JSON.stringify(projects, null, 2) }],
        };
      }

      case "jira_get_project": {
        const { projectKey } = GetProjectSchema.parse(args);
        const project = await jiraClient.getProject(projectKey);
        return {
          content: [{ type: "text", text: JSON.stringify(project, null, 2) }],
        };
      }

      case "jira_search_users": {
        const { query } = SearchUsersSchema.parse(args);
        const users = await jiraClient.searchUsers(query);
        return {
          content: [{ type: "text", text: JSON.stringify(users, null, 2) }],
        };
      }

      case "jira_get_current_user": {
        const user = await jiraClient.getCurrentUser();
        return {
          content: [{ type: "text", text: JSON.stringify(user, null, 2) }],
        };
      }

      case "jira_link_issues": {
        const { inwardIssue, outwardIssue, linkType } =
          LinkIssuesSchema.parse(args);
        await jiraClient.linkIssues(inwardIssue, outwardIssue, linkType);
        return {
          content: [
            {
              type: "text",
              text: `Issues ${inwardIssue} and ${outwardIssue} linked with type "${linkType}"`,
            },
          ],
        };
      }

      case "jira_add_watcher": {
        const { issueKey, username } = AddWatcherSchema.parse(args);
        await jiraClient.addWatcher(issueKey, username);
        return {
          content: [
            {
              type: "text",
              text: `Added ${username} as watcher to ${issueKey}`,
            },
          ],
        };
      }

      case "jira_get_priorities": {
        const priorities = await jiraClient.getPriorities();
        return {
          content: [
            { type: "text", text: JSON.stringify(priorities, null, 2) },
          ],
        };
      }

      case "jira_get_statuses": {
        const statuses = await jiraClient.getStatuses();
        return {
          content: [{ type: "text", text: JSON.stringify(statuses, null, 2) }],
        };
      }

      case "jira_get_create_meta": {
        const { projectKey, issueType } = GetCreateMetaSchema.parse(args);
        const meta = await jiraClient.getCreateMeta(projectKey, issueType);
        return {
          content: [{ type: "text", text: JSON.stringify(meta, null, 2) }],
        };
      }

      case "jira_get_edit_meta": {
        const { issueKey } = GetEditMetaSchema.parse(args);
        const meta = await jiraClient.getEditMeta(issueKey);
        return {
          content: [{ type: "text", text: JSON.stringify(meta, null, 2) }],
        };
      }

      case "jira_get_project_versions": {
        const { projectKey } = GetProjectVersionsSchema.parse(args);
        const versions = await jiraClient.getProjectVersions(projectKey);
        return {
          content: [{ type: "text", text: JSON.stringify(versions, null, 2) }],
        };
      }

      case "jira_get_project_components": {
        const { projectKey } = GetProjectComponentsSchema.parse(args);
        const components = await jiraClient.getProjectComponents(projectKey);
        return {
          content: [
            { type: "text", text: JSON.stringify(components, null, 2) },
          ],
        };
      }

      case "jira_get_fields": {
        const fields = await jiraClient.getFields();
        return {
          content: [{ type: "text", text: JSON.stringify(fields, null, 2) }],
        };
      }

      case "jira_get_field_options": {
        const { projectKey, issueType, fieldKey } =
          GetFieldOptionsSchema.parse(args);
        const options = await jiraClient.getFieldOptions(
          projectKey,
          issueType,
          fieldKey
        );
        return {
          content: [{ type: "text", text: JSON.stringify(options, null, 2) }],
        };
      }

      case "jira_get_issue_link_types": {
        const linkTypes = await jiraClient.getIssueLinkTypes();
        return {
          content: [{ type: "text", text: JSON.stringify(linkTypes, null, 2) }],
        };
      }

      case "jira_create_issue_advanced": {
        const {
          projectKey,
          summary,
          issueType,
          description,
          priority,
          assignee,
          reporter,
          labels,
          components,
          fixVersions,
          affectsVersions,
          customFields,
        } = CreateIssueAdvancedSchema.parse(args);

        const fields: Record<string, unknown> = {
          project: { key: projectKey },
          summary,
          issuetype: { name: issueType },
        };

        if (description) fields.description = description;
        if (priority) fields.priority = { name: priority };
        if (assignee) fields.assignee = { name: assignee };
        if (reporter) fields.reporter = { name: reporter };
        if (labels) fields.labels = labels;
        if (components)
          fields.components = components.map((name) => ({ name }));
        if (fixVersions)
          fields.fixVersions = fixVersions.map((name) => ({ name }));
        if (affectsVersions)
          fields.versions = affectsVersions.map((name) => ({ name }));

        // Merge custom fields
        if (customFields) {
          Object.assign(fields, customFields);
        }

        const issue = await jiraClient.createIssueRaw(fields);
        return {
          content: [{ type: "text", text: JSON.stringify(issue, null, 2) }],
        };
      }

      case "jira_update_issue_advanced": {
        const {
          issueKey,
          summary,
          description,
          priority,
          assignee,
          labels,
          components,
          fixVersions,
          affectsVersions,
          customFields,
        } = UpdateIssueAdvancedSchema.parse(args);

        const fields: Record<string, unknown> = {};

        if (summary) fields.summary = summary;
        if (description) fields.description = description;
        if (priority) fields.priority = { name: priority };
        if (assignee) fields.assignee = { name: assignee };
        if (labels) fields.labels = labels;
        if (components)
          fields.components = components.map((name) => ({ name }));
        if (fixVersions)
          fields.fixVersions = fixVersions.map((name) => ({ name }));
        if (affectsVersions)
          fields.versions = affectsVersions.map((name) => ({ name }));

        // Merge custom fields
        if (customFields) {
          Object.assign(fields, customFields);
        }

        await jiraClient.updateIssueRaw(issueKey, fields);
        return {
          content: [
            { type: "text", text: `Issue ${issueKey} updated successfully` },
          ],
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameters: ${error.errors.map((e) => e.message).join(", ")}`
      );
    }
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Error executing ${name}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Jira MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
