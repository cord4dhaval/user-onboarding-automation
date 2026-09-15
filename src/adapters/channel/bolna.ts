import { e164 } from "../../engine/address.js";
import {
  RetryableSendError,
  type CallResult,
  type ChannelAdapter,
  type OutboundMessage,
  type SendResult,
} from "./types.js";

const API = "https://api.bolna.ai";

/** Bolna's terminal states in which nobody was spoken to. */
const NOT_CONNECTED = new Set(["busy", "no-answer", "canceled", "failed", "stopped", "error", "balance-low"]);

export interface BolnaConfig {
  agentId: string;
  /** E.164. Absent means the account's default number. */
  fromPhoneNumber?: string;
}

/**
 * Places an AI voice call through Bolna.
 *
 * A call is not delivered when it is placed: Bolna queues it, dials, and only knows how it
 * went once someone hangs up. So a send is always "queued", and the reconciler reads the
 * execution back for whether anyone answered, for how long, and what was said.
 *
 * The brief the campaign composed travels as `brief` in user_data; the agent's own prompt in
 * Bolna decides how it is spoken. Merge variables ride along so that prompt can use a first
 * name or a company without the brief having to repeat them.
 */
export class BolnaAdapter implements ChannelAdapter {
  constructor(
    readonly key: string,
    private readonly token: string,
    private readonly config: BolnaConfig,
  ) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    // The agent reads the address back, so the trial link or invite it promises lands where
    // the lead expects. It rides inside the brief because the agent's prompt reads {brief}
    // and nothing else of ours.
    const email = message.vars?.email;
    const vars = { ...message.vars };
    delete vars.email;
    const brief = email ? `${message.bodyText}\n\nEMAIL ON FILE: ${email}` : message.bodyText;

    const payload = (await this.request("/call", {
      method: "POST",
      body: JSON.stringify({
        agent_id: this.config.agentId,
        recipient_phone_number: e164(message.to),
        ...(this.config.fromPhoneNumber ? { from_phone_number: this.config.fromPhoneNumber } : {}),
        user_data: { ...vars, brief },
      }),
    })) as { execution_id?: string; status?: string };

    if (!payload.execution_id) throw new Error("Bolna accepted the call but returned no execution id");
    return { accepted: true, disposition: "queued", providerMessageId: payload.execution_id, detail: payload.status };
  }

  async checkStatus(executionId: string): Promise<"queued" | "sending" | "sent" | "failed"> {
    const call = await this.callResult(executionId);
    return !call.done ? "sending" : call.connected ? "sent" : "failed";
  }

  async callResult(executionId: string): Promise<CallResult> {
    const e = (await this.request(`/executions/${encodeURIComponent(executionId)}`, {
      method: "GET",
    })) as BolnaExecution;
    const status = String(e.status ?? "unknown");
    const connected = status === "completed";
    return {
      status,
      done: connected || NOT_CONNECTED.has(status),
      connected,
      durationSec: num(e.conversation_duration ?? e.telephony_data?.duration),
      transcript: typeof e.transcript === "string" && e.transcript ? e.transcript : undefined,
      summary: typeof e.summary === "string" && e.summary ? e.summary : undefined,
      recordingUrl: e.telephony_data?.recording_url || undefined,
      hangupReason: e.telephony_data?.hangup_reason || undefined,
      costCents: num(e.total_cost),
      extracted: e.extracted_data && typeof e.extracted_data === "object" ? e.extracted_data : undefined,
      error: e.error_message || undefined,
      endedAt: e.updated_at ? new Date(e.updated_at) : undefined,
    };
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 429 || res.status === 503) {
      throw new RetryableSendError(`Bolna is throttling (HTTP ${res.status})`);
    }
    if (!res.ok) {
      // Bolna's error body is { error, message }. The message is kept, shortened: "agent not
      // found" and "unauthorized" are the difference between a wrong id and a wrong key.
      const body = (await res.json().catch(() => ({}))) as { message?: unknown };
      const why = typeof body.message === "string" ? ` (${body.message.slice(0, 120)})` : "";
      throw new Error(`Bolna answered HTTP ${res.status}${why}`);
    }
    return res.json();
  }
}

interface BolnaExecution {
  status?: string;
  transcript?: unknown;
  summary?: unknown;
  conversation_duration?: number | string;
  total_cost?: number | string;
  error_message?: string;
  extracted_data?: Record<string, unknown>;
  updated_at?: string;
  telephony_data?: { duration?: number | string; recording_url?: string; hangup_reason?: string };
}

function num(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
