import { meteredFetch } from "../subrequests";
import type { RoutineEnv } from "../../types";

/**
 * Everything that knows a browser-use URL.
 *
 * One file, for `lib/composio/client.ts`'s reason: a provider's vocabulary —
 * its paths, its header name, its status words, the fact that it returns a
 * cost as a string — is a thing to translate once at the edge rather than
 * everywhere it is read. Nothing here touches the database and nothing takes
 * a `ToolContext`, so the tool and the poller use the same three functions.
 *
 * **The version in the path is v2, which is not what the design doc says.**
 * The doc was written against `/api/v4/runs`; the live API is
 * `https://api.browser-use.com/api/v2` and `GET /tasks/{id}/status` is a
 * purpose-built lightweight polling endpoint — it answers status, output,
 * isSuccess and cost without loading steps, files or the session, which is
 * exactly and only what the poller wants.
 */

/** The provider's base. Overridable, for `COMPOSIO_BASE_URL`'s reason: the framework is MIT and self-hostable. */
const DEFAULT_BASE_URL = "https://api.browser-use.com/api/v2";

/**
 * How many steps one task may take.
 *
 * Sent rather than left to the provider's default, because the default is
 * theirs to move and this number is the per-task cost ceiling. 17c is their
 * published figure at 82% on a 106-task benchmark; a task that wanders is
 * where that average is lost.
 */
export const BROWSER_MAX_STEPS = 25;

/**
 * Long enough for the provider to accept a task, short enough that a hung
 * creation does not hold the turn.
 *
 * Creation answers 202 immediately — it does not wait for the browser — so
 * this bounds a network fault, not the work. Deliberately under
 * `TOOL_TIMEOUT_MS` (20s), which is the ceiling the harness would enforce
 * anyway.
 */
export const TIMEOUT_MS = 15_000;

export type BrowserEnv = Pick<
  RoutineEnv,
  "BROWSER_USE_API_KEY" | "BROWSER_USE_BASE_URL" | "SUBREQUESTS"
>;

/** Our vocabulary, not theirs. See `mapStatus`. */
export type BrowserTaskStatus = "queued" | "running" | "finished" | "failed" | "stopped";

export type CreatedTask = { id: string; sessionId: string };

export type TaskStatus = {
  status: BrowserTaskStatus;
  output: string | null;
  isSuccess: boolean | null;
  /** Dollars, parsed from the provider's string. Null until it finishes, and null if unparseable. */
  costUsd: number | null;
  finishedAt: string | null;
};

export type BrowserResult<T> =
  { kind: "ok"; value: T } | { kind: "error"; status: number; message: string };

export function hasBrowserKey(env: BrowserEnv): boolean {
  return Boolean(env.BROWSER_USE_API_KEY);
}

/**
 * Their five words to our five.
 *
 * `created`/`started` are the two that differ; the rest are identical and are
 * mapped anyway so the set is stated in one place. **Anything unrecognised is
 * `running`**, not an error: the provider's full task endpoint documents a
 * `paused` state this one does not, and a status word we have not met must
 * mean "come back later" rather than "fail the task". Guessing `finished`
 * would deliver an empty answer; guessing `failed` would throw away work
 * already paid for.
 */
function mapStatus(raw: unknown): BrowserTaskStatus {
  switch (String(raw)) {
    case "created":
      return "queued";
    case "finished":
      return "finished";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    default:
      return "running";
  }
}

/**
 * The provider's `cost` is a STRING, and absent until the task ends.
 *
 * `Number(undefined)` is `NaN`, and `NaN` into a numeric column fails the
 * insert with a message about the column rather than about the provider. So
 * this answers null for anything that is not a finite number.
 */
function parseCost(raw: unknown): number | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function baseOf(env: BrowserEnv): string {
  return (env.BROWSER_USE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export async function send<T>(
  env: BrowserEnv,
  path: string,
  init: { method: string; body?: unknown; redactBody?: boolean },
  opts: { signal?: AbortSignal } | undefined,
  parse: (body: unknown) => T,
): Promise<BrowserResult<T>> {
  const key = env.BROWSER_USE_API_KEY;
  // Checked here as well as by `isConfigured`, because the poller reads the
  // environment of a different Worker: a key set on the API Worker and not on
  // the cron one creates tasks that nothing ever polls.
  if (!key) {
    return {
      kind: "error",
      status: 501,
      message: "this deployment has no BROWSER_USE_API_KEY, so it cannot run browser tasks",
    };
  }

  // Counted like every other outbound call. See `lib/subrequests.ts`.
  const fetchImpl = meteredFetch(env) ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${baseOf(env)}${path}`, {
      method: init.method,
      headers: {
        // The provider's own header name, and no `Bearer` prefix. Their key
        // starts `bu_`.
        "X-Browser-Use-API-Key": key,
        Accept: "application/json",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: opts?.signal ?? AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return {
      kind: "error",
      status: 0,
      message: err instanceof Error ? err.message : "could not reach browser-use",
    };
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    /**
     * The body is returned on a failure as well as a success, for
     * `http_request`'s reason: a provider that says *why* tells the caller how
     * to fix it, where "400 Bad Request" tells it nothing.
     *
     * **Except when the request carried a provider id**, and then it is
     * withheld — because this message does not stop here. `browse.ts` wraps it,
     * `loop.ts:1020` turns it into `error: ${result.message}`, and
     * `loop.ts:1028` writes that to `message_steps.result_excerpt`, which
     * `0060:104` grants `authenticated` a select on for EVERY column, gated
     * only on whether the message is visible. In a shared session that is every
     * member of the workspace. A validation error that echoes the submitted
     * `sessionSettings` would hand them `provider_profile_id` — the column the
     * grants in 0077 exist to withhold, leaked by the error path instead.
     *
     * Conditional rather than always, because on a call that carries no id
     * there is nothing to protect and the provider's sentence is the whole
     * diagnostic value.
     */
    return {
      kind: "error",
      status: res.status,
      message: init.redactBody
        ? `${res.status} ${res.statusText}`
        : `${res.status} ${res.statusText}${text ? `\n${text.slice(0, 2_000)}` : ""}`,
    };
  }

  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    return {
      kind: "error",
      status: res.status,
      message: "browser-use answered something that is not JSON",
    };
  }
  return { kind: "ok", value: parse(body) };
}

/**
 * Hand a task over. Answers as soon as the provider has accepted it (202),
 * not when the browser has finished — that is the whole point of the design.
 *
 * **`secrets` and `opVaultId` are deliberately never populated.** The
 * provider accepts both, and this build does not: Covan never receives a
 * credential, full stop. But that is no longer the whole boundary — a
 * profile is a credential too, one that arrived through `sessionSettings`
 * instead of `secrets`, because the person typed it into a browser Covan
 * rented rather than into Covan. See `profiles.ts` and the spec it implements.
 */
export function createTask(
  env: BrowserEnv,
  input: { task: string; profileId?: string; proxyCountryCode?: string | null },
  opts?: { signal?: AbortSignal },
): Promise<BrowserResult<CreatedTask>> {
  return send(
    env,
    "/tasks",
    {
      method: "POST",
      body: {
        task: input.task,
        maxSteps: BROWSER_MAX_STEPS,
        // `sessionSettings` configures the session the provider auto-creates.
        // Omitted entirely when there is no profile, so a public-web task is
        // byte-for-byte the request it was before this feature existed.
        ...(input.profileId
          ? {
              sessionSettings: {
                profileId: input.profileId,
                ...(input.proxyCountryCode === undefined
                  ? {}
                  : { proxyCountryCode: input.proxyCountryCode }),
              },
            }
          : {}),
      },
      // Only when the request named a profile. See `send`.
      redactBody: Boolean(input.profileId),
    },
    opts,
    (body) => {
      const row = (body ?? {}) as Record<string, unknown>;
      return { id: String(row.id ?? ""), sessionId: String(row.sessionId ?? "") };
    },
  );
}

/** The lightweight polling endpoint: status, output, isSuccess, cost. No steps, no files, no session. */
export function taskStatus(
  env: BrowserEnv,
  providerTaskId: string,
  opts?: { signal?: AbortSignal },
): Promise<BrowserResult<TaskStatus>> {
  return send(
    env,
    `/tasks/${encodeURIComponent(providerTaskId)}/status`,
    { method: "GET" },
    opts,
    (body) => {
      const row = (body ?? {}) as Record<string, unknown>;
      return {
        status: mapStatus(row.status),
        output: typeof row.output === "string" && row.output ? row.output : null,
        isSuccess: typeof row.isSuccess === "boolean" ? row.isSuccess : null,
        costUsd: parseCost(row.cost),
        finishedAt: typeof row.finishedAt === "string" && row.finishedAt ? row.finishedAt : null,
      };
    },
  );
}

/**
 * Stop a task and its browser.
 *
 * `stop_task_and_session` rather than `stop`: a stopped task on a live
 * session keeps billing browser time at $0.02/hour for work nobody will
 * read.
 */
export function stopTask(
  env: BrowserEnv,
  providerTaskId: string,
  opts?: { signal?: AbortSignal },
): Promise<BrowserResult<null>> {
  return send(
    env,
    `/tasks/${encodeURIComponent(providerTaskId)}`,
    { method: "PATCH", body: { action: "stop_task_and_session" } },
    opts,
    () => null,
  );
}
