# Jira MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-2026--07--28-purple)](https://modelcontextprotocol.io)

[![npm](https://img.shields.io/npm/v/jira-mcp-server-pro)](https://www.npmjs.com/package/jira-mcp-server-pro)
[![CI](https://github.com/yogeshhrathod/jiraMCP/actions/workflows/ci.yml/badge.svg)](https://github.com/yogeshhrathod/jiraMCP/actions/workflows/ci.yml)

A Model Context Protocol (MCP) server for self-hosted Jira instances using Personal Access Token (PAT) authentication.

## ✨ Features

- **Smart field handling**: values are matched against each field's real selectable options (dropdowns, multi-selects, cascading selects, versions, components, priorities) before anything is sent to Jira. Harmless differences (case, spacing, unique partial names) are fixed; ambiguous or invalid values are never guessed.
- **Asks instead of failing**: on clients that support MCP elicitation, ambiguous values, unknown projects and missing required fields are put to the user as choices. Other clients get the valid options in the error so the model can ask.
- **Project discovery**: a project key that does not exist (renamed, split or retired) returns the closest live projects instead of a blind failure.
- **Duplicate-safe create**: timeouts and dropped connections are not retried blindly; the server looks for the ticket it may have created. The response reports the real key/project (Jira automation can move tickets).
- **Workflow-aware transitions**: transitions by name, with required transition-screen fields (resolution, assignee, comment) resolved against their real options.
- **Works across Jira versions**: create metadata falls back from the paged endpoint to the legacy endpoint to edit metadata.
- **Current MCP**: built on the v2 TypeScript SDK. One server serves both the 2025 and the 2026-07-28 protocol revisions (see [MCP features](#-mcp-features)).
- Issues, JQL search, comments, projects, users, watchers and links.

## 📋 Prerequisites

- Node.js 20+
- Self-hosted Jira Server / Data Center (tested with 9.x and 10.x)
- Personal Access Token (PAT) for authentication

## 🚀 Installation

```bash
npm install
npm run build
```

## ⚙️ Configuration

Create a `.env` file in the project root:

```env
JIRA_BASE_URL=https://your-jira-instance.com/
PAT=your-personal-access-token
```

### Getting a Personal Access Token

1. Log in to your Jira instance
2. Go to Profile → Personal Access Tokens
3. Create a new token with appropriate permissions
4. Copy the token to your `.env` file

## 📖 Usage

### Running the Server

```bash
npm start
```

### Development Mode

```bash
npm run dev
```

### Using with npx (Recommended)

No installation required! Add the following to your MCP configuration:

```json
{
  "mcpServers": {
    "jira": {
      "command": "npx",
      "args": ["-y", "jira-mcp-server-pro"],
      "env": {
        "JIRA_BASE_URL": "https://your-jira-instance.com/",
        "PAT": "your-personal-access-token"
      }
    }
  }
}
```

### Global Installation

```bash
npm install -g jira-mcp-server-pro
```

Then add to your MCP configuration:

```json
{
  "mcpServers": {
    "jira": {
      "command": "jira-mcp-server-pro",
      "env": {
        "JIRA_BASE_URL": "https://your-jira-instance.com/",
        "PAT": "your-personal-access-token"
      }
    }
  }
}
```

### Local Development

If running from source, add the following to your MCP configuration:

```json
{
  "mcpServers": {
    "jira": {
      "command": "node",
      "args": ["/path/to/jiraMCP/dist/index.js"],
      "env": {
        "JIRA_BASE_URL": "https://your-jira-instance.com/",
        "PAT": "your-personal-access-token"
      }
    }
  }
}
```

## 🛠️ Available Tools (29)

All tools carry MCP annotations (read-only / destructive / idempotent hints) and a human-readable title.

### Smart create, update and transition

| Tool                         | Description                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `jira_create_issue`          | Create an issue; issue type, priority and other options are validated against real options. Supports `dryRun`.              |
| `jira_create_issue_advanced` | Adds components, versions, reporter and `customFields` (by field id **or display name**). Supports `dryRun`.                |
| `jira_update_issue`          | Update basic fields with option matching against the issue's editable fields                                                |
| `jira_update_issue_advanced` | Update any editable field, including custom fields                                                                          |
| `jira_transition_issue`      | Transition by name or id; required transition-screen fields (resolution, assignee, comment) are resolved or asked for       |

### Discovery

| Tool                         | Description                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `jira_find_project`          | Fuzzy project lookup by key or name                                                  |
| `jira_get_field_options`     | Selectable options of a field (by id or name), optionally ranked against a query     |
| `jira_get_create_meta`       | Fields, required flags and options for a project and issue type                      |
| `jira_get_edit_meta`         | Editable fields and options for an existing issue                                    |
| `jira_get_transitions`       | Transitions with the fields each requires                                            |
| `jira_get_projects` / `jira_get_project` / `jira_get_project_versions` / `jira_get_project_components` | Project data |
| `jira_get_fields` / `jira_get_priorities` / `jira_get_statuses` / `jira_get_issue_link_types`        | Instance metadata |
| `jira_search_users` / `jira_get_current_user` | Users                                                                      |

### Issues and comments

| Tool                                                   | Description                                       |
| ------------------------------------------------------ | ------------------------------------------------- |
| `jira_get_issue`, `jira_search_issues`                 | Read and JQL search                               |
| `jira_assign_issue`, `jira_link_issues`, `jira_add_watcher` | Assign, link, watch                          |
| `jira_get_comments`, `jira_add_comment`                | Comments                                          |
| `jira_delete_issue`                                    | Destructive; asks for confirmation when supported |
| `jira_report_issue`                                    | Builds a redacted GitHub issue draft; nothing is filed automatically |

## 🔌 MCP features

| Feature | How it is used |
| --- | --- |
| Tools with `title`, annotations, `outputSchema` and `structuredContent` | Every tool; read-only, destructive and idempotent hints; typed results for create/update/transition |
| Elicitation (multi-round-trip `input_required`) | Ambiguous values, unknown projects, missing required fields, delete confirmation. Answers are carried in signed `requestState`, so it also works on the 2025 protocol via the SDK's compatibility shim |
| Resource links | Create/update/search results link to `jira://issue/{key}` |
| Resources and resource templates with completion | Projects, issues, create-fields; project keys and issue types autocomplete |
| Prompts with argument completion | `create-ticket`, `close-ticket`, `my-work-summary` |
| Cache hints (`ttlMs`, `cacheScope`) | Tool/prompt lists cached for a day; Jira reference data (priorities, statuses, fields) for five minutes |
| Progress notifications | Reported while creating an issue when the client sends a progress token |
| Cancellation | The request's abort signal reaches the Jira HTTP call |
| Server `instructions` | Tells the model how to handle ambiguous values, lost responses and repeated failures |
| Registry metadata | `server.json` and `mcpName` for the official MCP Registry |

Deliberately not used: MCP **logging, sampling and roots** are deprecated in the 2026-07-28 revision (diagnostics go to stderr instead). **Tasks** and HTTP transports are not needed for a local stdio server where every operation is short; adding an HTTP transport would expose a token-backed server on the network, so it is intentionally left out.

## 🧠 How value resolution works

For every field you pass, the server reads Jira's metadata for that project/issue type (or the issue, when updating) and:

1. finds the field by id or display name,
2. matches the value to the field's options by id, exact label, normalized label, then unique prefix/substring,
3. shapes it correctly (`{id}` for selects, arrays for multi-selects, `{id, child:{id}}` for cascading selects, `{name}` for users),
4. for anything ambiguous or invalid, asks the user (elicitation) or returns the closest valid options,
5. asks for required fields that were not provided.

Cascading selects accept `"Parent > Child"`. Use `dryRun: true` to preview the exact payload.

## 📝 Workflow: creating issues

```
jira_create_issue_advanced(
  projectKey: "PROJ",
  issueType: "bug",              // matched to "Bug"
  summary: "Login fails",
  priority: "high",              // matched to the real priority name
  customFields: { "Environment": "staging" },
  dryRun: true
)
```

Review the returned payload, then call again without `dryRun`.

## 💬 Prompts

| Prompt            | Purpose                                                  |
| ----------------- | -------------------------------------------------------- |
| `create-ticket`   | Guided creation: find project, dry run, confirm, create  |
| `close-ticket`    | Close with the resolution/comment the workflow requires  |
| `my-work-summary` | Summarize your open issues by priority                   |

Prompt arguments such as `project` support autocompletion.

## 📚 Resources

| Resource URI                               | Description                                                     |
| ------------------------------------------ | --------------------------------------------------------------- |
| `jira://current-user`                      | Authenticated user                                              |
| `jira://priorities` / `jira://statuses`    | Priorities and statuses                                         |
| `jira://fields`                            | System and custom fields                                        |
| `jira://link-types`                        | Issue link types                                                |
| `jira://projects`                          | Projects (key, name, type)                                      |
| `jira://my-issues`                         | Open issues assigned to you                                     |
| `jira://project/{key}`                     | Versions, components and issue types (key autocompletes)        |
| `jira://issue/{key}`                       | An issue                                                        |
| `jira://project/{key}/fields/{issueType}`  | Fields, required flags and options for creating that issue type |

## 🔍 Example JQL Queries

```
# Issues assigned to me
assignee = currentUser()

# Open bugs in a project
project = PROJ AND issuetype = Bug AND status != Done

# Issues created in the last 7 days
created >= -7d

# High priority issues
priority in (Highest, High)
```

## 🤝 Contributing

Contributions are welcome! Here's how you can help:

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** your changes (`git commit -m 'Add amazing feature'`)
4. **Push** to the branch (`git push origin feature/amazing-feature`)
5. **Open** a Pull Request

### Development Setup

```bash
# Clone your fork
git clone https://github.com/yogeshhrathod/jiraMCP.git
cd jiraMCP

# Install dependencies
npm install

# Run in development mode
npm run dev
```

### Reporting Issues

- Use the [GitHub Issues](https://github.com/yogeshhrathod/jiraMCP/issues) to report bugs
- Include your Node.js version, Jira version, and steps to reproduce
- Check existing issues before creating a new one

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [Model Context Protocol](https://modelcontextprotocol.io) for the MCP specification
- [Atlassian](https://www.atlassian.com/) for Jira REST API documentation

---

<p align="center">
  Made with ❤️ for the MCP community
</p>

## 🐞 Repeated failures and bug reports

If a tool fails twice with the same error, or fails with an unexpected server error, the response tells the AI to stop retrying and suggest a GitHub issue. `jira_report_issue` then prepares a draft with the tool name, redacted error, and versions, plus a prefilled link. Tokens, hostnames, emails, ticket keys and quoted values are stripped, and nothing is submitted until the user opens the link.

## 🔒 Security

Credentials are read only from the `JIRA_BASE_URL` and `PAT` environment variables (or a local `.env`, which is git-ignored). Nothing is logged or returned that contains the token. Keep tokens out of committed MCP client configs, and rotate any token that was ever committed or shared.

Optional: `JIRA_REQUEST_TIMEOUT_MS` (default 120000).

## 🧪 Tests

```bash
npm test
```

Unit tests cover option matching and redaction. Integration tests start the real server over stdio against a fake Jira and run each scenario on both protocol eras, including multi-round elicitation.

## 📦 MCP Registry

The repository ships `server.json` and `mcpName` so the package can be listed in the [official MCP Registry](https://modelcontextprotocol.io/registry/quickstart) (`mcp-publisher login github && mcp-publisher publish`, after the npm release).
