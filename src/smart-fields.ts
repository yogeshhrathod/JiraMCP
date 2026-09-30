import type { FieldMeta, FieldOption } from "./types.js";

export const optionLabel = (o: FieldOption): string =>
  String(o.name ?? o.value ?? o.label ?? o.key ?? o.id ?? "");

const lower = (s: string) => s.toLowerCase().trim();
const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function bigrams(s: string): Map<string, number> {
  const c = compact(s);
  const m = new Map<string, number>();
  if (c.length < 2) {
    if (c) m.set(c, 1);
    return m;
  }
  for (let i = 0; i < c.length - 1; i++) {
    const g = c.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

export function similarity(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  let total = 0;
  let overlap = 0;
  x.forEach((n) => (total += n));
  y.forEach((n, g) => {
    total += n;
    overlap += Math.min(n, x.get(g) ?? 0);
  });
  return total ? (2 * overlap) / total : 0;
}

export function rankOptions(
  query: string,
  options: FieldOption[],
  limit = 10
): FieldOption[] {
  const q = compact(query);
  return options
    .map((o) => {
      const c = compact(optionLabel(o));
      const boost = q && c.includes(q) ? 0.5 : 0;
      return { o, score: similarity(query, optionLabel(o)) + boost };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.o);
}

export type MatchResult =
  | { status: "matched"; option: FieldOption; how: string }
  | { status: "ambiguous"; candidates: FieldOption[] }
  | { status: "none"; suggestions: FieldOption[] };

/**
 * Match free-form input against a list of selectable options. Only
 * unambiguous matches are auto-accepted; anything doubtful is reported back
 * as ambiguous/none so the caller can ask instead of guessing.
 */
export function matchOption(input: string, options: FieldOption[]): MatchResult {
  const text = input.trim();
  const byId = options.filter((o) => o.id !== undefined && String(o.id) === text);
  if (byId.length === 1) return { status: "matched", option: byId[0], how: "id" };

  const exact = options.filter((o) => lower(optionLabel(o)) === lower(text));
  if (exact.length === 1) return { status: "matched", option: exact[0], how: "exact" };
  if (exact.length > 1) return { status: "ambiguous", candidates: exact };

  const c = compact(text);
  if (c) {
    const same = options.filter((o) => compact(optionLabel(o)) === c);
    if (same.length === 1) return { status: "matched", option: same[0], how: "normalized" };
    if (same.length > 1) return { status: "ambiguous", candidates: same };

    if (c.length >= 2) {
      const partial = options.filter((o) => {
        const l = compact(optionLabel(o));
        return l.startsWith(c) || (c.length >= 3 && l.includes(c));
      });
      if (partial.length === 1) return { status: "matched", option: partial[0], how: "partial" };
      if (partial.length > 1) return { status: "ambiguous", candidates: partial.slice(0, 10) };
    }
  }

  const ranked = rankOptions(text, options, 5);
  const best = ranked[0];
  const second = ranked[1];
  if (best) {
    const s1 = similarity(text, optionLabel(best));
    const s2 = second ? similarity(text, optionLabel(second)) : 0;
    if (s1 >= 0.9 && s1 - s2 >= 0.15) return { status: "matched", option: best, how: "fuzzy" };
    if (s1 >= 0.4) return { status: "ambiguous", candidates: ranked.filter((o) => similarity(text, optionLabel(o)) >= 0.3) };
  }
  return { status: "none", suggestions: ranked };
}

export interface FieldProblem {
  fieldId: string;
  fieldName: string;
  kind: "ambiguous" | "invalid" | "missing" | "unknown-field";
  input?: string;
  message: string;
  options?: string[];
}

type Outcome =
  | { ok: true; value: unknown; notes: string[] }
  | { ok: false; problem: FieldProblem; item?: string; candidates: FieldOption[] };

const asStrings = (input: unknown): string[] => {
  const one = (v: unknown): string => {
    if (v && typeof v === "object") {
      const o = v as FieldOption;
      return String(o.id ?? o.name ?? o.value ?? o.key ?? "");
    }
    return String(v);
  };
  return (Array.isArray(input) ? input : [input]).map(one).filter((s) => s !== "");
};

const optionValue = (o: FieldOption): Record<string, unknown> =>
  o.id !== undefined ? { id: String(o.id) } : o.value !== undefined ? { value: o.value } : { name: o.name };

const cap = (opts: FieldOption[], n = 25) => opts.slice(0, n).map(optionLabel);

function isCascading(meta: FieldMeta): boolean {
  return !!meta.schema?.custom?.endsWith("cascadingselect");
}

function isMulti(meta: FieldMeta): boolean {
  return meta.schema?.type === "array" || !!meta.schema?.custom?.endsWith("multiselect") || !!meta.schema?.custom?.endsWith("multicheckboxes");
}

function isUser(meta: FieldMeta): boolean {
  return meta.schema?.type === "user" || meta.schema?.items === "user";
}

function failure(meta: FieldMeta, input: string, r: MatchResult, item?: string): Outcome {
  const candidates = r.status === "ambiguous" ? r.candidates : r.status === "none" ? r.suggestions : [];
  const kind = r.status === "ambiguous" ? "ambiguous" : "invalid";
  const listing = cap(candidates).join(", ");
  return {
    ok: false,
    item: item ?? input,
    candidates,
    problem: {
      fieldId: meta.fieldId,
      fieldName: meta.name,
      kind,
      input,
      options: cap(candidates),
      message:
        kind === "ambiguous"
          ? `Field "${meta.name}" (${meta.fieldId}): "${input}" matches several options (${listing}). Ask the user which one, then retry with the exact option.`
          : `Field "${meta.name}" (${meta.fieldId}): "${input}" is not a valid option.${listing ? ` Closest options: ${listing}.` : ""} Use jira_get_field_options to see all valid values.`,
    },
  };
}

function resolveCascading(meta: FieldMeta, input: unknown): Outcome {
  const options = meta.allowedValues ?? [];
  let parent: string;
  let child: string | undefined;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const o = input as FieldOption;
    parent = String(o.id ?? o.value ?? o.name ?? "");
    const c = o.child as FieldOption | undefined;
    child = c ? String(c.id ?? c.value ?? c.name ?? "") : undefined;
  } else {
    [parent, child] = String(input).split(/\s*(?:>|\/|\||::)\s*/, 2);
  }
  const p = matchOption(parent, options);
  if (p.status !== "matched") return failure(meta, parent, p);
  const value: Record<string, unknown> = { ...optionValue(p.option) };
  const notes: string[] = [];
  if (child) {
    const c = matchOption(child, p.option.children ?? []);
    if (c.status !== "matched") return failure(meta, `${optionLabel(p.option)} > ${child}`, c, child);
    value.child = optionValue(c.option);
  }
  return { ok: true, value, notes };
}

export function resolveField(meta: FieldMeta, input: unknown): Outcome {
  const notes: string[] = [];
  const options = meta.allowedValues;

  if (options && options.length && !isUser(meta)) {
    if (isCascading(meta)) return resolveCascading(meta, input);

    let items = asStrings(input);
    if (isMulti(meta) && items.length === 1 && typeof input === "string" && input.includes(",")) {
      if (matchOption(items[0], options).status !== "matched") {
        items = input.split(",").map((s) => s.trim()).filter(Boolean);
      }
    }
    const resolved: Array<Record<string, unknown>> = [];
    for (const item of items) {
      const r = matchOption(item, options);
      if (r.status !== "matched") return failure(meta, item, r);
      if (r.how !== "id" && r.how !== "exact") {
        notes.push(`${meta.name}: "${item}" resolved to "${optionLabel(r.option)}"`);
      }
      resolved.push(optionValue(r.option));
    }
    return { ok: true, value: isMulti(meta) ? resolved : resolved[0], notes };
  }

  if (isUser(meta)) {
    const users = asStrings(input).map((name) => ({ name }));
    return { ok: true, value: meta.schema?.type === "array" ? users : users[0], notes };
  }

  if (meta.schema?.type === "array") {
    const items = asStrings(input);
    const system = meta.schema.system;
    const named = system === "components" || system === "fixVersions" || system === "versions" || (meta.schema.items && !["string", "option"].includes(meta.schema.items));
    return { ok: true, value: named ? items.map((name) => ({ name })) : items, notes };
  }

  if (meta.schema?.type === "number") {
    const n = Number(input);
    return { ok: true, value: Number.isNaN(n) ? input : n, notes };
  }
  return { ok: true, value: input, notes };
}

/** Shape a value when no metadata is available for the field. */
export function fallbackShape(fieldId: string, input: unknown): unknown {
  if (input && typeof input === "object" && !Array.isArray(input)) return input;
  if (fieldId === "priority" || fieldId === "assignee" || fieldId === "reporter" || fieldId === "resolution") {
    return { name: String(input) };
  }
  if (fieldId === "components" || fieldId === "fixVersions" || fieldId === "versions") {
    return asStrings(input).map((name) => ({ name }));
  }
  return input;
}

export function findField(fields: FieldMeta[], key: string): FieldMeta | undefined {
  const k = lower(key);
  return (
    fields.find((f) => f.fieldId === key) ??
    fields.find((f) => lower(f.fieldId) === k) ??
    fields.find((f) => lower(f.name) === k) ??
    (() => {
      const c = compact(key);
      const hits = fields.filter((f) => compact(f.name) === c || compact(f.fieldId) === c);
      return hits.length === 1 ? hits[0] : undefined;
    })()
  );
}

export interface Elicitor {
  choose(opts: { message: string; label: string; options: Array<{ value: string; title: string }> }): Promise<string | undefined>;
  text(opts: { message: string; label: string }): Promise<string | undefined>;
}

export interface ResolveAllResult {
  fields: Record<string, unknown>;
  notes: string[];
  problems: FieldProblem[];
}

const NEVER_REQUIRED_ASK = new Set(["project", "issuetype", "reporter", "attachment", "comment"]);

/**
 * Resolve every provided field against Jira's metadata. Ambiguous or invalid
 * selections are put to the user through elicitation when the client supports
 * it; otherwise they are returned as problems with the valid options. Required
 * fields that were not provided are asked for the same way.
 */
export async function resolveAll(
  input: Record<string, unknown>,
  meta: FieldMeta[],
  opts: { accurate: boolean; elicitor?: Elicitor; checkRequired?: boolean; skip?: Set<string> }
): Promise<ResolveAllResult> {
  const out: ResolveAllResult = { fields: {}, notes: [], problems: [] };
  const { elicitor } = opts;

  for (const [key, raw] of Object.entries(input)) {
    if (raw === undefined || raw === null) continue;
    const field = findField(meta, key);
    if (!field) {
      if (meta.length && opts.accurate) {
        const near = rankOptions(key, meta.map((f) => ({ id: f.fieldId, name: f.name })), 5).map(optionLabel);
        out.problems.push({
          fieldId: key,
          fieldName: key,
          kind: "unknown-field",
          input: String(key),
          options: near,
          message: `Field "${key}" is not available for this issue type.${near.length ? ` Did you mean: ${near.join(", ")}?` : ""}`,
        });
      } else {
        out.fields[key] = fallbackShape(key, raw);
        out.notes.push(`${key}: no metadata available, value sent unverified`);
      }
      continue;
    }

    let current: unknown = raw;
    for (let attempt = 0; attempt < 6; attempt++) {
      const r = resolveField(field, current);
      if (r.ok) {
        out.fields[field.fieldId] = r.value;
        out.notes.push(...r.notes);
        break;
      }
      const picked = elicitor && r.candidates.length
        ? await elicitor.choose({
            message: r.problem.message.split(" Ask the user")[0],
            label: field.name,
            options: r.candidates.slice(0, 25).map((o) => ({ value: String(o.id ?? optionLabel(o)), title: optionLabel(o) })),
          })
        : undefined;
      if (picked === undefined) {
        out.problems.push(r.problem);
        break;
      }
      current = Array.isArray(current)
        ? asStrings(current).map((v) => (v === r.item ? picked : v))
        : typeof current === "string" && r.item !== current && current.includes(r.item ?? "")
          ? current.replace(r.item as string, picked)
          : picked;
    }
  }

  if (opts.checkRequired) {
    for (const f of meta) {
      if (!f.required || f.hasDefaultValue || NEVER_REQUIRED_ASK.has(f.fieldId) || opts.skip?.has(f.fieldId)) continue;
      if (out.fields[f.fieldId] !== undefined) continue;
      if (out.problems.some((p) => p.fieldId === f.fieldId)) continue;

      const label = f.name;
      let answer: string | undefined;
      if (elicitor) {
        answer = f.allowedValues?.length && !isUser(f)
          ? await elicitor.choose({
              message: `"${label}" is required. Choose a value.`,
              label,
              options: f.allowedValues.slice(0, 25).map((o) => ({ value: String(o.id ?? optionLabel(o)), title: optionLabel(o) })),
            })
          : await elicitor.text({ message: `"${label}" is required. Enter a value.`, label });
      }
      if (answer === undefined) {
        out.problems.push({
          fieldId: f.fieldId,
          fieldName: label,
          kind: "missing",
          options: f.allowedValues ? cap(f.allowedValues) : undefined,
          message: `Required field "${label}" (${f.fieldId}) was not provided.${f.allowedValues?.length ? ` Valid options: ${cap(f.allowedValues).join(", ")}.` : ""}`,
        });
        continue;
      }
      const r = resolveField(f, answer);
      if (r.ok) out.fields[f.fieldId] = r.value;
      else out.problems.push(r.problem);
    }
  }
  return out;
}
