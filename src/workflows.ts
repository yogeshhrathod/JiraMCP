import { JiraApiError, type JiraClient } from "./jira-client.js";
import {
  PENDING,
  matchOption,
  optionLabel,
  rankOptions,
  resolveAll,
  type Elicitor,
  type FieldProblem,
} from "./smart-fields.js";
import type { FieldMeta, FieldOption, JiraProject } from "./types.js";

export type Prepared =
  | { ready: true; fields: Record<string, unknown>; notes: string[]; metaSource?: string }
  | { ready: false; awaiting?: boolean; problems: FieldProblem[]; notes: string[] };

const problem = (fieldId: string, fieldName: string, kind: FieldProblem["kind"], message: string, options?: string[], input?: string): FieldProblem =>
  ({ fieldId, fieldName, kind, message, options, input });

export async function findProjects(client: JiraClient, query: string, limit = 10): Promise<JiraProject[]> {
  const projects = await client.getProjects();
  const q = query.trim().toLowerCase();
  if (!q) return projects.slice(0, limit);
  const scored = projects.map((p) => {
    const key = p.key.toLowerCase();
    const name = p.name.toLowerCase();
    let score = 0;
    if (key === q) score = 10;
    else if (key.startsWith(q) || q.startsWith(key)) score = 6 - Math.abs(key.length - q.length) * 0.05;
    else if (name.includes(q) || key.includes(q)) score = 4;
    else {
      const words = q.split(/\s+/).filter(Boolean);
      const hits = words.filter((w) => name.includes(w) || key.includes(w)).length;
      score = words.length ? (hits / words.length) * 3 : 0;
    }
    return { p, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.p);
}

/** Confirm a project exists; otherwise suggest (or ask for) the closest live projects. */
export async function resolveProject(
  client: JiraClient,
  requested: string,
  elicitor?: Elicitor
): Promise<{ key: string; note?: string } | { problem: FieldProblem } | { awaiting: true }> {
  for (const candidate of new Set([requested, requested.toUpperCase()])) {
    try {
      const p = await client.getProject(candidate);
      return { key: p.key };
    } catch (error) {
      if (!(error instanceof JiraApiError) || ![400, 404].includes(error.status)) throw error;
    }
  }
  const suggestions = await findProjects(client, requested, 10);
  const listing = suggestions.map((p) => `${p.key} (${p.name})`);
  if (elicitor && suggestions.length) {
    const picked = await elicitor.choose({
      key: "project",
      message: `Project "${requested}" does not exist. Which project should be used?`,
      label: "Project",
      options: suggestions.map((p) => ({ value: p.key, title: `${p.key} - ${p.name}` })),
    });
    if (picked === PENDING) return { awaiting: true };
    if (picked) return { key: picked, note: `Project "${requested}" does not exist; user selected ${picked}` };
  }
  return {
    problem: problem(
      "project", "Project", "invalid",
      `Project "${requested}" does not exist or is not visible to this user.` +
        (listing.length ? ` Closest existing projects: ${listing.join(", ")}.` : " No similar project was found; use jira_find_project or jira_get_projects.") +
        " Confirm the project with the user before retrying.",
      listing, requested
    )
  };
}

async function loadMeta(client: JiraClient, project: string, issueType: string) {
  try {
    const meta = await client.getCreateMeta(project, issueType);
    const it = meta.issueTypes.find((t) => t.name.toLowerCase() === issueType.toLowerCase()) ?? meta.issueTypes[0];
    return { fields: it?.fields ?? [], accurate: meta.accurate, source: meta.metaSource };
  } catch {
    return { fields: [] as FieldMeta[], accurate: false, source: "unavailable" };
  }
}

export interface CreateInput {
  projectKey: string;
  summary: string;
  issueType: string;
  description?: string;
  priority?: string;
  assignee?: string;
  reporter?: string;
  labels?: string[];
  components?: string[];
  fixVersions?: string[];
  affectsVersions?: string[];
  customFields?: Record<string, unknown>;
}

export async function prepareCreate(client: JiraClient, args: CreateInput, elicitor?: Elicitor): Promise<Prepared> {
  const notes: string[] = [];

  const project = await resolveProject(client, args.projectKey, elicitor);
  if ("awaiting" in project) return { ready: false, awaiting: true, problems: [], notes };
  if ("problem" in project) return { ready: false, problems: [project.problem], notes };
  if (project.note) notes.push(project.note);

  const types = (await client.getCreateMetaIssueTypes(project.key)).values.map((t) => ({ id: t.id, name: t.name }));
  const tm = matchOption(args.issueType, types);
  let issueType: FieldOption | undefined = tm.status === "matched" ? tm.option : undefined;
  if (!issueType) {
    const candidates = tm.status === "none" ? tm.suggestions : tm.status === "ambiguous" ? tm.candidates : [];
    const all = (candidates.length ? candidates : types).slice(0, 25);
    const picked = elicitor
      ? await elicitor.choose({
          key: "issuetype",
          message: `"${args.issueType}" is not a valid issue type in ${project.key}. Choose one.`,
          label: "Issue type",
          options: all.map((t) => ({ value: String(t.id), title: optionLabel(t) })),
        })
      : undefined;
    if (picked === PENDING) return { ready: false, awaiting: true, problems: [], notes };
    issueType = all.find((t) => String(t.id) === picked);
    if (!issueType) {
      return {
        ready: false,
        notes,
        problems: [problem("issuetype", "Issue type", "invalid",
          `Issue type "${args.issueType}" is not available in project ${project.key}. Available types: ${types.map((t) => t.name).join(", ")}.`,
          types.map((t) => t.name), args.issueType)],
      };
    }
  } else if (tm.status === "matched" && tm.how !== "exact" && tm.how !== "id") {
    notes.push(`Issue type "${args.issueType}" resolved to "${issueType.name}"`);
  }

  const meta = await loadMeta(client, project.key, String(issueType.name));
  if (!meta.accurate) notes.push(`Field metadata source: ${meta.source} (approximate; required fields may not be fully known)`);

  const wanted: Record<string, unknown> = {
    summary: args.summary,
    description: args.description,
    priority: args.priority,
    assignee: args.assignee,
    reporter: args.reporter,
    labels: args.labels,
    components: args.components,
    fixVersions: args.fixVersions,
    versions: args.affectsVersions,
  };
  for (const [k, v] of Object.entries(args.customFields ?? {})) wanted[k] = v;

  const resolved = await resolveAll(wanted, meta.fields, {
    accurate: meta.accurate || meta.fields.length > 0,
    elicitor,
    checkRequired: true,
    skip: new Set(["summary"]),
  });
  notes.push(...resolved.notes);
  if (resolved.awaiting) return { ready: false, awaiting: true, problems: resolved.problems, notes };
  if (resolved.problems.length) return { ready: false, problems: resolved.problems, notes };

  return {
    ready: true,
    notes,
    metaSource: meta.source,
    fields: { project: { key: project.key }, issuetype: { id: String(issueType.id) }, ...resolved.fields },
  };
}

export interface UpdateInput {
  summary?: string;
  description?: string;
  priority?: string;
  assignee?: string;
  labels?: string[];
  components?: string[];
  fixVersions?: string[];
  affectsVersions?: string[];
  customFields?: Record<string, unknown>;
}

export async function prepareUpdate(client: JiraClient, issueKey: string, args: UpdateInput, elicitor?: Elicitor): Promise<Prepared> {
  const meta = await client.getEditFieldMeta(issueKey);
  const wanted: Record<string, unknown> = {
    summary: args.summary,
    description: args.description,
    priority: args.priority,
    assignee: args.assignee,
    labels: args.labels,
    components: args.components,
    fixVersions: args.fixVersions,
    versions: args.affectsVersions,
  };
  for (const [k, v] of Object.entries(args.customFields ?? {})) wanted[k] = v;
  for (const k of Object.keys(wanted)) if (wanted[k] === undefined) delete wanted[k];

  const r = await resolveAll(wanted, meta, { accurate: true, elicitor });
  if (r.awaiting) return { ready: false, awaiting: true, problems: r.problems, notes: r.notes };
  if (r.problems.length) return { ready: false, problems: r.problems, notes: r.notes };
  return { ready: true, fields: r.fields, notes: r.notes };
}

export interface TransitionInput {
  transitionId?: string;
  transition?: string;
  comment?: string;
  fields?: Record<string, unknown>;
}

export type PreparedTransition =
  | { ready: true; transitionId: string; transitionName: string; comment?: string; fields?: Record<string, unknown>; notes: string[] }
  | { ready: false; awaiting?: boolean; problems: FieldProblem[]; notes: string[] };

export async function prepareTransition(client: JiraClient, issueKey: string, args: TransitionInput, elicitor?: Elicitor): Promise<PreparedTransition> {
  const { transitions } = await client.getTransitions(issueKey);
  const notes: string[] = [];
  const query = args.transitionId ?? args.transition;
  if (!query) {
    return { ready: false, notes, problems: [problem("transition", "Transition", "missing",
      `Provide transitionId or transition. Available: ${transitions.map((t) => `${t.name} (id ${t.id}) -> ${t.to?.name}`).join(", ")}.`,
      transitions.map((t) => t.name))] };
  }

  const byName = transitions.map((t) => ({ id: t.id, name: t.name }));
  const byTarget = transitions.map((t) => ({ id: t.id, name: t.to?.name ?? t.name }));
  let m = matchOption(query, byName);
  if (m.status !== "matched") {
    const alt = matchOption(query, byTarget);
    if (alt.status === "matched") m = alt;
  }
  let chosen = m.status === "matched" ? transitions.find((t) => t.id === String(m.option.id)) : undefined;
  if (!chosen) {
    const picked = elicitor
      ? await elicitor.choose({
          key: "transition",
          message: `"${query}" is not an available transition for ${issueKey}. Choose one.`,
          label: "Transition",
          options: transitions.map((t) => ({ value: t.id, title: `${t.name} -> ${t.to?.name}` })),
        })
      : undefined;
    if (picked === PENDING) return { ready: false, awaiting: true, notes, problems: [] };
    chosen = transitions.find((t) => t.id === picked);
    if (!chosen) {
      return { ready: false, notes, problems: [problem("transition", "Transition", "invalid",
        `"${query}" is not an available transition for ${issueKey}. Available: ${transitions.map((t) => `${t.name} (id ${t.id}) -> ${t.to?.name}`).join(", ")}.`,
        transitions.map((t) => t.name), query)] };
    }
  }

  const meta = client.normalizeFields(chosen.fields as never);
  let comment = args.comment;
  const commentMeta = meta.find((f) => f.fieldId === "comment");
  if (commentMeta?.required && !comment) {
    const asked = elicitor ? await elicitor.text({ key: "comment", message: "This transition requires a comment.", label: "Comment" }) : undefined;
    if (asked === PENDING) return { ready: false, awaiting: true, notes, problems: [] };
    comment = asked;
    if (!comment) {
      return { ready: false, notes, problems: [problem("comment", "Comment", "missing", `Transition "${chosen.name}" requires a comment. Provide the comment argument.`)] };
    }
  }

  const r = await resolveAll(args.fields ?? {}, meta.filter((f) => f.fieldId !== "comment"), {
    accurate: true,
    elicitor,
    checkRequired: true,
  });
  notes.push(...r.notes);
  if (r.awaiting) return { ready: false, awaiting: true, notes, problems: r.problems };
  if (r.problems.length) return { ready: false, notes, problems: r.problems };
  return {
    ready: true,
    transitionId: chosen.id,
    transitionName: chosen.name,
    comment,
    fields: Object.keys(r.fields).length ? r.fields : undefined,
    notes,
  };
}

/** Allowed values for one field, optionally ranked against a query. */
export async function fieldOptions(
  client: JiraClient,
  opts: { projectKey?: string; issueType?: string; issueKey?: string; fieldKey: string; query?: string; limit?: number }
) {
  let fields: FieldMeta[];
  let source: string;
  if (opts.issueKey) {
    fields = await client.getEditFieldMeta(opts.issueKey);
    source = `editmeta of ${opts.issueKey}`;
  } else if (opts.projectKey && opts.issueType) {
    const meta = await loadMeta(client, opts.projectKey, opts.issueType);
    fields = meta.fields;
    source = meta.source;
  } else {
    throw new Error("Provide issueKey, or both projectKey and issueType.");
  }
  const key = opts.fieldKey.toLowerCase();
  const field = fields.find((f) => f.fieldId.toLowerCase() === key || f.name.toLowerCase() === key);
  if (!field) {
    const near = rankOptions(opts.fieldKey, fields.map((f) => ({ id: f.fieldId, name: f.name })), 5).map(optionLabel);
    throw new Error(`Field "${opts.fieldKey}" not found. Did you mean: ${near.join(", ")}?`);
  }
  let options = field.allowedValues ?? [];
  if (opts.query) options = rankOptions(opts.query, options, opts.limit ?? 10);
  else if (opts.limit) options = options.slice(0, opts.limit);
  return {
    fieldId: field.fieldId,
    name: field.name,
    required: field.required,
    type: field.schema?.custom ?? field.schema?.type,
    multiple: field.schema?.type === "array",
    source,
    hasAllowedValues: !!field.allowedValues,
    options: options.map((o) => ({ id: o.id, label: optionLabel(o), children: o.children?.map(optionLabel) })),
  };
}
