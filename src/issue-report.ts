const MAX_FIELD = 1500;
const MAX_URL = 6000;

/** Remove anything that could identify the user's Jira instance, people or tickets. */
export function redact(text: string, extraHosts: string[] = []): string {
  let out = text;
  for (const h of extraHosts.filter(Boolean)) out = out.split(h).join("<host>");
  out = out
    .replace(/https?:\/\/[^\s"'<>)]+/gi, "<url>")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>")
    .replace(/\b[A-Za-z0-9+/=_-]{24,}\b/g, "<redacted>")
    .replace(/\b[A-Z][A-Z0-9_]+-\d+\b/g, "<ISSUE-KEY>")
    .replace(/\b(?:[a-z0-9-]+\.){2,}[a-z]{2,}\b/gi, "<host>")
    .replace(/"[^"\n]{1,120}"/g, '"<value>"')
    .replace(/'[^'\n]{1,120}'/g, "'<value>'");
  return out.length > MAX_FIELD ? `${out.slice(0, MAX_FIELD)}... (truncated)` : out;
}

export interface ReportDraft {
  title: string;
  body: string;
  url: string;
}

export function buildReport(opts: {
  bugsUrl: string;
  tool: string;
  problem: string;
  errorMessage?: string;
  serverVersion: string;
  jiraVersion?: string;
  hosts?: string[];
}): ReportDraft {
  const hosts = opts.hosts ?? [];
  const title = `[${opts.tool}] ${redact(opts.problem, hosts).split("\n")[0]}`.slice(0, 120);
  const body = [
    "## What happened",
    redact(opts.problem, hosts),
    "",
    "## Tool",
    `\`${opts.tool}\``,
    "",
    "## Error (redacted)",
    "```",
    opts.errorMessage ? redact(opts.errorMessage, hosts) : "(none provided)",
    "```",
    "",
    "## Environment",
    `- jira-mcp-server-pro: ${opts.serverVersion}`,
    `- Jira: ${opts.jiraVersion ?? "unknown"}`,
    `- Node: ${process.version}`,
    "",
    "<!-- Review before submitting: remove anything internal. Never paste tokens or hostnames. -->",
  ].join("\n");

  let url = `${opts.bugsUrl.replace(/\/$/, "")}/new?labels=bug&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  if (url.length > MAX_URL) {
    url = `${opts.bugsUrl.replace(/\/$/, "")}/new?labels=bug&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body.slice(0, 2500))}`;
  }
  return { title, body, url };
}

const normalize = (s: string) =>
  s.replace(/"[^"\n]*"/g, '""').replace(/\d+/g, "#").replace(/\s+/g, " ").slice(0, 200);

/** Counts identical failures of a tool within a time window. */
export class FailureTracker {
  private entries = new Map<string, { count: number; at: number }>();
  constructor(private windowMs = 15 * 60_000) {}

  record(tool: string, message: string, now = Date.now()): number {
    const key = `${tool}|${normalize(message)}`;
    const e = this.entries.get(key);
    const count = e && now - e.at <= this.windowMs ? e.count + 1 : 1;
    this.entries.set(key, { count, at: now });
    return count;
  }

  clear(tool: string) {
    for (const k of [...this.entries.keys()]) if (k.startsWith(`${tool}|`)) this.entries.delete(k);
  }
}

/** Hint appended to an error when it keeps repeating or looks like a bug rather than bad input. */
export function issueHint(opts: { tool: string; count: number; unexpected: boolean; bugsUrl: string }): string | undefined {
  if (opts.count < 2 && !opts.unexpected) return undefined;
  const why = opts.unexpected
    ? "This looks like an unexpected server error, not a problem with the inputs."
    : `This has now failed ${opts.count} times with the same error.`;
  return (
    `${why} If changing the inputs does not fix it, it may be a bug or an unsupported Jira setup that the AI cannot work around. ` +
    `Stop retrying and suggest the user report it: call jira_report_issue (prepares a redacted GitHub issue draft; nothing is filed automatically) ` +
    `or open ${opts.bugsUrl}. Never include tokens, hostnames or ticket contents.`
  );
}
