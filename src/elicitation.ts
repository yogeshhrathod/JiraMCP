import { randomBytes } from "node:crypto";
import {
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  type InputRequest,
  type InputRequiredResult,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { PENDING, type Answer, type Elicitor } from "./smart-fields.js";

type Answers = Record<string, string | null>;
interface FlowState {
  answers: Answers;
}

// Answers are carried in requestState between rounds. The key only needs to live for this
// process (stdio connections are per process), and the state is signed so a client cannot forge it.
const codec = createRequestStateCodec<FlowState>({ key: randomBytes(32), ttlSeconds: 900 });
export const requestStateVerify = codec.verify;

export interface Flow extends Elicitor {
  readonly pending: Record<string, InputRequest>;
  readonly answers: Answers;
}

/** Whether the requesting client declared support for form elicitation, on either protocol era. */
export function supportsElicitation(ctx: ServerContext, legacyCapabilities?: { elicitation?: unknown }): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const fromEnvelope = (envelope?.["io.modelcontextprotocol/clientCapabilities"] ?? envelope?.clientCapabilities) as Record<string, unknown> | undefined;
  const caps = (fromEnvelope ?? legacyCapabilities) as Record<string, unknown> | undefined;
  return caps?.elicitation !== undefined;
}

/** Restores answers from earlier rounds and folds in the ones that arrived with this retry. */
export function loadAnswers(ctx: ServerContext): Answers {
  const answers: Answers = { ...(ctx.mcpReq.requestState<FlowState>()?.answers ?? {}) };
  for (const key of Object.keys(ctx.mcpReq.inputResponses ?? {})) {
    const view = inputResponse(ctx.mcpReq.inputResponses, key);
    if (view.kind !== "elicit") continue;
    const value = view.action === "accept" ? (view.content as { value?: unknown } | undefined)?.value : undefined;
    answers[key] = typeof value === "string" ? value : null;
  }
  return answers;
}

/**
 * An Elicitor built for multi-round-trip requests: questions that already have an answer are
 * replayed, new ones are queued as `input_required` elicitation requests. The handler must be
 * deterministic so the same questions come up again on retry.
 */
export function createFlow(answers: Answers): Flow {
  const pending: Record<string, InputRequest> = {};
  const ask = (key: string, message: string, property: Record<string, unknown>): Answer => {
    if (key in answers) return answers[key] ?? undefined;
    pending[key] = inputRequired.elicit({
      message,
      requestedSchema: { type: "object", properties: { value: property as never }, required: ["value"] },
    });
    return PENDING;
  };
  return {
    pending,
    answers,
    async choose({ key, message, label, options }) {
      return ask(key, message, { type: "string", title: label, oneOf: options.map((o) => ({ const: o.value, title: o.title })) });
    },
    async text({ key, message, label }) {
      return ask(key, message, { type: "string", title: label });
    },
  };
}

/** If any questions were queued, turn them into the `input_required` result for this round. */
export async function pendingResult(flow: Flow | undefined): Promise<InputRequiredResult | undefined> {
  if (!flow || !Object.keys(flow.pending).length) return undefined;
  return inputRequired({ inputRequests: flow.pending, requestState: await codec.mint({ answers: flow.answers }) });
}
