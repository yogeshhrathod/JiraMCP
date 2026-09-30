# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/yogeshhrathod/jiraMCP/security/advisories/new)
(Security tab, "Report a vulnerability"). Do not open a public issue for vulnerabilities.

Include the affected version, what you found, and how to reproduce it. Do not include real tokens,
hostnames or ticket contents.

## Handling credentials

- The server reads `JIRA_BASE_URL` and `PAT` from environment variables (or a local, git-ignored `.env`).
- It never logs or returns the token. Error reports prepared by `jira_report_issue` are redacted
  (tokens, hostnames, emails, ticket keys, quoted values).
- Keep tokens out of committed MCP client configs. Use a token with the least privilege you need and
  rotate it if it may have been exposed.
- A Personal Access Token acts as you. Anything that can call this server's tools can change tickets as you,
  so only connect it to clients you trust. Destructive tools are annotated (`destructiveHint`) and
  deletion asks for confirmation on clients that support elicitation.

## Supported versions

Only the latest published minor version receives fixes.
