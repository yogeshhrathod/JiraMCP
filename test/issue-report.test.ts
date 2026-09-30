import { test } from "node:test";
import assert from "node:assert/strict";
import { FailureTracker, buildReport, issueHint, redact } from "../src/issue-report.js";

test("redact strips urls, hosts, emails, tokens, issue keys and quoted values", () => {
  const out = redact(
    'GET https://jira.example.corp/rest/api/2/issue/ABC-123 failed for jane@example.corp on jira.example.corp with token abcdefghijklmnopqrstuvwxyz0123 project "Secret Project"'
  );
  for (const leak of ["example.corp", "jane", "ABC-123", "abcdefghij", "Secret"]) assert.ok(!out.includes(leak), `leaked ${leak}: ${out}`);
});

test("redact keeps version-like strings and filenames readable", () => {
  assert.ok(redact("version 5.3.0-14 in jira-client.js").includes("5.3.0-14"));
});

test("buildReport produces a github new-issue url without secrets", () => {
  const r = buildReport({
    bugsUrl: "https://github.com/o/r/issues",
    tool: "jira_create_issue",
    problem: "Create fails for https://x.internal.corp",
    errorMessage: "Jira API error (500): boom",
    serverVersion: "1.2.3",
    jiraVersion: "10.3.1",
  });
  assert.ok(r.url.startsWith("https://github.com/o/r/issues/new?labels=bug&title="));
  assert.ok(!decodeURIComponent(r.url).includes("internal.corp"));
  assert.ok(r.body.includes("10.3.1"));
});

test("FailureTracker counts identical failures and resets by window/tool", () => {
  const t = new FailureTracker(1000);
  assert.equal(t.record("a", 'Field "X" bad 1', 0), 1);
  assert.equal(t.record("a", 'Field "Y" bad 2', 500), 2);
  assert.equal(t.record("a", "different", 600), 1);
  assert.equal(t.record("a", 'Field "X" bad 1', 5000), 1);
  t.clear("a");
  assert.equal(t.record("a", "different", 5100), 1);
});

test("issueHint only appears for repeats or unexpected errors", () => {
  const base = { tool: "t", bugsUrl: "https://github.com/o/r/issues" };
  assert.equal(issueHint({ ...base, count: 1, unexpected: false }), undefined);
  assert.ok(issueHint({ ...base, count: 2, unexpected: false })!.includes("jira_report_issue"));
  assert.ok(issueHint({ ...base, count: 1, unexpected: true }));
});
