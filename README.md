# Jira MCP Server

A Model Context Protocol (MCP) server for self-hosted Jira instances using Personal Access Token (PAT) authentication.

## Features

- **Issue Management**: Get, create, update, delete, and assign issues
- **Search**: Search issues using JQL
- **Comments**: Get, add, update, and delete comments
- **Transitions**: Get available transitions and transition issues
- **Projects**: List and get project details
- **Users**: Search users and get current user
- **Watchers**: Add watchers to issues
- **Issue Links**: Link issues together

## Prerequisites

- Node.js 18+
- Self-hosted Jira instance (tested with v9.12.12)
- Personal Access Token (PAT) for authentication

## Installation

```bash
npm install
npm run build
```

## Configuration

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

## Usage

### Running the Server

```bash
npm start
```

### Development Mode

```bash
npm run dev
```

### Adding to Windsurf/Cursor

Add the following to your MCP configuration:

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

## Available Tools (27 total)

### Issue Operations

| Tool                         | Description                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `jira_get_issue`             | Get details of a Jira issue by its key                                        |
| `jira_search_issues`         | Search for issues using JQL                                                   |
| `jira_create_issue`          | Create a new issue (basic fields)                                             |
| `jira_create_issue_advanced` | Create issue with full field support (fixVersions, components, custom fields) |
| `jira_update_issue`          | Update an existing issue (basic fields)                                       |
| `jira_update_issue_advanced` | Update issue with full field support                                          |
| `jira_delete_issue`          | Delete an issue                                                               |
| `jira_assign_issue`          | Assign or unassign an issue                                                   |
| `jira_get_transitions`       | Get available transitions for an issue                                        |
| `jira_transition_issue`      | Transition an issue to a new status                                           |
| `jira_link_issues`           | Link two issues                                                               |
| `jira_add_watcher`           | Add a watcher to an issue                                                     |

### Comments

| Tool                | Description               |
| ------------------- | ------------------------- |
| `jira_get_comments` | Get comments on an issue  |
| `jira_add_comment`  | Add a comment to an issue |

### Projects

| Tool                          | Description                                      |
| ----------------------------- | ------------------------------------------------ |
| `jira_get_projects`           | Get all projects                                 |
| `jira_get_project`            | Get details of a specific project                |
| `jira_get_project_versions`   | Get all versions for a project (for fixVersions) |
| `jira_get_project_components` | Get all components for a project                 |

### Metadata & Field Discovery

| Tool                        | Description                                                               |
| --------------------------- | ------------------------------------------------------------------------- |
| `jira_get_create_meta`      | **IMPORTANT**: Get required fields and allowed values for creating issues |
| `jira_get_edit_meta`        | Get editable fields and allowed values for an existing issue              |
| `jira_get_fields`           | Get all available fields including custom fields                          |
| `jira_get_field_options`    | Get allowed values for a specific field                                   |
| `jira_get_priorities`       | Get all available priorities                                              |
| `jira_get_statuses`         | Get all available statuses                                                |
| `jira_get_issue_link_types` | Get all available issue link types                                        |

### Users

| Tool                    | Description                        |
| ----------------------- | ---------------------------------- |
| `jira_search_users`     | Search for users                   |
| `jira_get_current_user` | Get the current authenticated user |

## Workflow: Creating Issues with Required Fields

1. **First**, call `jira_get_create_meta` to discover required fields and allowed values:

   ```
   jira_get_create_meta(projectKey: "PROJ", issueType: "Bug")
   ```

   This returns all fields with their requirements and dropdown options.

2. **Then**, use `jira_create_issue_advanced` with the correct values:
   ```
   jira_create_issue_advanced(
     projectKey: "PROJ",
     summary: "Issue title",
     issueType: "Bug",
     fixVersions: ["1.0.0"],
     components: ["Backend"],
     customFields: {"customfield_10001": "value"}
   )
   ```

## Resources

The server exposes MCP Resources for quick access to Jira data without tool calls:

| Resource URI           | Description                                            |
| ---------------------- | ------------------------------------------------------ |
| `jira://config`        | Server configuration and connection info               |
| `jira://current-user`  | Currently authenticated user details                   |
| `jira://priorities`    | All available issue priorities                         |
| `jira://statuses`      | All available issue statuses                           |
| `jira://fields`        | All fields (system + custom) grouped by type           |
| `jira://link-types`    | Available issue link types                             |
| `jira://projects`      | List of all projects (key, name, type)                 |
| `jira://project/{KEY}` | Project details with versions, components, issue types |
| `jira://my-issues`     | Issues assigned to current user                        |

### Using Resources

Resources provide context without explicit tool calls. For example, reading `jira://project/MSSP` returns:

```json
{
  "key": "MSSP",
  "name": "MSSP",
  "versions": [{"name": "1.0.0", "released": true}, ...],
  "components": [{"name": "LOGIN"}, {"name": "MSSP-FO"}, ...],
  "issueTypes": [{"id": "1", "name": "Bug"}, {"id": "3", "name": "Task"}, ...]
}
```

## Example JQL Queries

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

## License

MIT
