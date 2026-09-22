/**
 * Supabase's own Management API, as much of it as Covan needs.
 *
 * Two entry points and nothing else: list the projects a token can see, and
 * say where a project's read-only query endpoint lives. The query itself is
 * POSTed by `lib/harness/tools/query-database.ts` rather than from here, and
 * that split is deliberate — the tool already carries the origin guard, the
 * byte cap and the turn's abort signal, and a second fetch path would be a
 * second place to forget one of them.
 *
 * WHY THE MANAGEMENT API AND NOT POSTGREST. The PostgREST road (0059,
 * `covan_query`) needs a function installed in the target database before it
 * can carry a statement, which is a page of documentation between a person and
 * their own data. This one needs nothing in the project at all: the account's
 * token is enough, and Supabase runs the statement as `supabase_read_only_user`
 * — so read-onlyness is still the database's guarantee rather than ours, which
 * is the property the PostgREST road was built around and the one worth
 * keeping. Both roads stay open; they ask for different things and a person
 * picks which they would rather give.
 */

/** Where the hosted Management API lives. Stored on the row, not assumed. */
export const MANAGEMENT_BASE = "https://api.supabase.com";

/** Long enough for a cold project list, short enough to fail a form politely. */
const TIMEOUT_MS = 15_000;

/** Enough of an error body to diagnose, not enough to fill a log line. */
const MAX_ERROR_CHARS = 500;

/**
 * A project as the picker needs it.
 *
 * `status` is here because a paused project is one a person will otherwise
 * connect and then wonder about; the interface says so rather than letting the
 * first query answer it.
 */
export type SupabaseProject = {
  ref: string;
  name: string;
  region: string;
  status: string;
};

export type ProjectsResult =
  { kind: "ok"; projects: SupabaseProject[] } | { kind: "error"; status: number; message: string };

/**
 * Every project this token can see.
 *
 * Returns its failure rather than throwing it, for the same reason the tools
 * in `lib/harness` do: the caller is a route rendering a form, and "that token
 * was not accepted" is a sentence it has to show, not an exception it has to
 * catch.
 */
export async function listProjects(
  token: string,
  opts?: { base?: string; signal?: AbortSignal },
): Promise<ProjectsResult> {
  const base = (opts?.base ?? MANAGEMENT_BASE).replace(/\/+$/, "");

  let res: Response;
  try {
    res = await fetch(`${base}/v1/projects`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "covan/1.0",
      },
      redirect: "manual",
      signal: opts?.signal ?? AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return {
      kind: "error",
      status: 502,
      message: err instanceof Error ? err.message : "could not reach Supabase",
    };
  }

  if (res.status === 401 || res.status === 403) {
    return {
      kind: "error",
      status: res.status,
      message: "Supabase did not accept that token. Check it has not expired or been revoked.",
    };
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, MAX_ERROR_CHARS);
    return {
      kind: "error",
      status: res.status,
      message: body || `Supabase answered ${res.status}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return { kind: "error", status: 502, message: "Supabase's project list was not JSON" };
  }
  if (!Array.isArray(parsed)) {
    return { kind: "error", status: 502, message: "Supabase's project list was not a list" };
  }

  // An entry with no ref is one nothing can be done with: it cannot be
  // connected, and showing it in the picker would offer a choice that fails on
  // click. Dropped rather than rendered as a blank row.
  const projects = parsed
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .filter((row) => typeof row.ref === "string" && row.ref.length > 0)
    .map((row) => ({
      ref: String(row.ref),
      name: typeof row.name === "string" ? row.name : String(row.ref),
      region: typeof row.region === "string" ? row.region : "",
      status: typeof row.status === "string" ? row.status : "",
    }));

  return { kind: "ok", projects };
}

/**
 * Where a project's read-only statements go.
 *
 * `/database/query/read-only` rather than `/database/query` with a flag: the
 * dedicated endpoint cannot be asked for anything else, so a future edit that
 * drops a parameter cannot quietly turn into a writable connection.
 */
export function readOnlyQueryUrl(base: string, ref: string): string {
  const root = base.replace(/\/+$/, "");
  return `${root}/v1/projects/${encodeURIComponent(ref)}/database/query/read-only`;
}
