import type { ZodType } from 'zod';
import {
  type Command,
  type EventsResponse,
  eventsResponseSchema,
  type Snapshot,
  snapshotSchema,
  type Vocabulary,
  vocabularySchema,
} from '../protocol';

/**
 * HTTP transport for the control CLI.
 *
 * A thin wrapper over the endpoints and nothing more: an orchestrator would
 * post the same JSON directly, so anything clever here would be a behaviour the
 * API does not actually have.
 */

export const DEFAULT_BASE = 'http://127.0.0.1:8765/api';

/** Long enough to cover a `--wait` on a turn that runs its full course. */
const DEFAULT_TIMEOUT_MS = 180_000;

/** Print and stop. Every failure the CLI has is fatal to the one thing it does. */
export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/**
 * Read a response through its schema, so a field the CLI prints is a field the
 * server actually promised.
 */
function expect<T>(schema: ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) fail(`予期しない応答: ${JSON.stringify(body)}`);
  return parsed.data;
}

export class ControlClient {
  constructor(private readonly base: string = DEFAULT_BASE) {}

  /** GET when there is no payload, POST when there is. */
  async request(path: string, payload?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      fail(`制御サーバに接続できない (${this.base}): ${reason(error)}\n  yarn dev で起動する`);
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // An error page rather than an error object: hand the body back so the
      // caller can see what answered.
      return response.ok ? {} : { error: `HTTP ${response.status}`, body: text };
    }
  }

  /**
   * Send one command. The reply is passed through unread — `ok` is about
   * delivery, and what the caller wants to see is whatever the server said.
   */
  command(command: Command, wait?: string): Promise<unknown> {
    return this.request(`/command${wait ? `?wait=${wait}` : ''}`, command);
  }

  async state(): Promise<Snapshot> {
    return expect(snapshotSchema, await this.request('/state'));
  }

  /** Empty until a viewer has connected: it is discovered from the avatar. */
  async vocabulary(): Promise<Partial<Vocabulary>> {
    return expect(vocabularySchema.partial(), await this.request('/vocabulary'));
  }

  /** Long poll: returns as soon as there is an event newer than `since`. */
  async events(since: number, waitSeconds: number): Promise<EventsResponse> {
    const body = await this.request(
      `/events?since=${since}&wait=${waitSeconds}`,
      undefined,
      (waitSeconds + 30) * 1000,
    );
    return expect(eventsResponseSchema, body);
  }
}

/** The bit of a fetch failure worth showing: usually ECONNREFUSED. */
function reason(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause;
    if (cause instanceof Error) return cause.message;
    return error.message;
  }
  return String(error);
}
