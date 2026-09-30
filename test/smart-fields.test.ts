import { test } from "node:test";
import assert from "node:assert/strict";
import { matchOption, resolveAll, resolveField, type Elicitor } from "../src/smart-fields.js";
import type { FieldMeta } from "../src/types.js";

const priority: FieldMeta = {
  fieldId: "priority", name: "Priority", required: false, hasDefaultValue: false, hasAllowedValues: true,
  schema: { type: "priority", system: "priority" },
  allowedValues: [{ id: "1", name: "P1-Critical" }, { id: "2", name: "P2-High" }, { id: "3", name: "P3-Medium" }],
};
const datacenter: FieldMeta = {
  fieldId: "customfield_100", name: "Datacenter", required: true, hasDefaultValue: false, hasAllowedValues: true,
  schema: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" },
  allowedValues: [{ id: "10", value: "IN01" }, { id: "11", value: "IN03" }, { id: "12", value: "US01" }],
};
const envs: FieldMeta = {
  fieldId: "customfield_200", name: "Environments", required: false, hasDefaultValue: false, hasAllowedValues: true,
  schema: { type: "array", items: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:multiselect" },
  allowedValues: [{ id: "1", value: "Dev" }, { id: "2", value: "Staging" }, { id: "3", value: "Prod" }],
};
const cascade: FieldMeta = {
  fieldId: "customfield_300", name: "Instance", required: false, hasDefaultValue: false, hasAllowedValues: true,
  schema: { type: "option-with-child", custom: "com.atlassian.jira.plugin.system.customfieldtypes:cascadingselect" },
  allowedValues: [
    { id: "100", value: "P28", children: [{ id: "101", value: "eng.in03_Dev" }, { id: "102", value: "eng.in03_Prod" }] },
    { id: "200", value: "P29", children: [{ id: "201", value: "eng.us01_Dev" }] },
  ],
};
const fixVersions: FieldMeta = {
  fieldId: "fixVersions", name: "Fix Version/s", required: false, hasDefaultValue: false, hasAllowedValues: true,
  schema: { type: "array", items: "version", system: "fixVersions" },
  allowedValues: [{ id: "9", name: "5.3.0-14" }, { id: "8", name: "5.3.0-13" }],
};
const labels: FieldMeta = { fieldId: "labels", name: "Labels", required: false, hasDefaultValue: false, hasAllowedValues: false, schema: { type: "array", items: "string", system: "labels" } };
const all = [priority, datacenter, envs, cascade, fixVersions, labels];

test("matchOption: exact, normalized, partial and ambiguous", () => {
  const opts = priority.allowedValues!;
  assert.equal((matchOption("p2-high", opts) as any).option.id, "2");
  assert.equal((matchOption("P2 High", opts) as any).option.id, "2");
  assert.equal((matchOption("critical", opts) as any).option.id, "1");
  assert.notEqual(matchOption("P", opts).status, "matched");
  assert.equal(matchOption("zzzz", opts).status, "none");
});

test("select field resolves to id shape", () => {
  const r = resolveField(datacenter, "in03");
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.value, { id: "11" });
});

test("invalid select value is rejected with options, never guessed", () => {
  const r = resolveField(datacenter, "IN99");
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.problem.options!.length > 0);
});

test("multi-select accepts comma string and arrays", () => {
  assert.deepEqual((resolveField(envs, "dev, prod") as any).value, [{ id: "1" }, { id: "3" }]);
  assert.deepEqual((resolveField(envs, ["Staging"]) as any).value, [{ id: "2" }]);
});

test("cascading select resolves parent and child", () => {
  assert.deepEqual((resolveField(cascade, "p28 > eng.in03_dev") as any).value, { id: "100", child: { id: "101" } });
  assert.equal(resolveField(cascade, "P28 > nope").ok, false);
});

test("version-like names resolve exactly", () => {
  assert.deepEqual((resolveField(fixVersions, ["5.3.0-14"]) as any).value, [{ id: "9" }]);
});

test("free-text arrays and user fields pass through correctly", () => {
  assert.deepEqual((resolveField(labels, ["a", "b"]) as any).value, ["a", "b"]);
  const user: FieldMeta = { fieldId: "assignee", name: "Assignee", required: false, hasDefaultValue: false, hasAllowedValues: false, schema: { type: "user", system: "assignee" } };
  assert.deepEqual((resolveField(user, "jdoe") as any).value, { name: "jdoe" });
});

test("resolveAll accepts field display names and reports unknown fields", async () => {
  const r = await resolveAll({ Datacenter: "IN03", priority: "high", Bogus: "x" }, all, { accurate: true });
  assert.deepEqual(r.fields, { customfield_100: { id: "11" }, priority: { id: "2" } });
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].kind, "unknown-field");
});

test("missing required field is reported with options when no elicitation", async () => {
  const r = await resolveAll({ priority: "P1" }, all, { accurate: true, checkRequired: true });
  assert.equal(r.problems[0].kind, "missing");
  assert.ok(r.problems[0].options!.includes("IN03"));
});

test("elicitor is asked to resolve ambiguity and missing required fields", async () => {
  const asked: string[] = [];
  const elicitor: Elicitor = {
    async choose({ label, options }) {
      asked.push(label);
      return label === "Datacenter" ? options.find((o) => o.title === "US01")!.value : options[0].value;
    },
    async text() { return undefined; },
  };
  const r = await resolveAll({ priority: "P" }, all, { accurate: true, checkRequired: true, elicitor });
  assert.deepEqual(asked, ["Priority", "Datacenter"]);
  assert.equal(r.problems.length, 0);
  assert.deepEqual(r.fields.customfield_100, { id: "12" });
  assert.ok(r.fields.priority);
});

test("declined elicitation falls back to a problem", async () => {
  const elicitor: Elicitor = { async choose() { return undefined; }, async text() { return undefined; } };
  const r = await resolveAll({ customfield_100: "nope" }, all, { accurate: true, elicitor });
  assert.equal(r.problems.length, 1);
});
