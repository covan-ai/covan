/**
 * What a client role may write, held to what it may write today.
 *
 * The security boundary in this schema is two things in series: a GRANT says
 * which columns a role may name at all, and a POLICY says which rows. 0023
 * granted every table to both client roles wholesale and left the policies to
 * do all of it, and the trouble lived in that
 * gap: a policy that scoped the row correctly and a grant that let the row be
 * rewritten into something else -- a document's storage key, a membership's
 * user, a key's tags. Each was fixed by narrowing a grant to the columns the
 * product writes (0085, 0086, 0088).
 *
 * This file is what keeps them narrow. It reads the grants off the live
 * database, so nothing a migration can say about itself stands in for what it
 * did.
 *
 *  - `anon` holds nothing in `public`, and can call no definer function
 *    (0089). Nothing in Covan runs as `anon`; the anon key is public by design.
 *  - `authenticated` may INSERT and UPDATE exactly the columns below. A wider
 *    grant fails here until somebody writes the column in on purpose; a
 *    narrower one fails until the snapshot is tightened to match, so the
 *    ratchet only ever turns one way.
 */

import { afterAll, describe, expect, it } from "vitest";
import { closeSql, sql } from "./harness";

/**
 * `"<table> <INSERT|UPDATE>": "<columns, sorted>"`. Tables absent here grant
 * `authenticated` neither.
 *
 * Since 0094 every table that 0023 granted wholesale is granted only the
 * columns the API writes through a caller's client. The few still listed
 * whole (`connection_grants`, `coverage_opt_outs`, `notification_preferences`,
 * `user_onboarding`) are tables where every column is the caller's own to set.
 */
const AUTHENTICATED_WRITES: Record<string, string> = {
  "agent_bundles INSERT": "agent_id,bundle_id",
  // 0104: `workspace_access` is chosen when the agent is made and is INSERT
  // only. Changing it afterwards is `set_agent_sharing`'s, which checks for
  // `manage`; an UPDATE grant here would let anybody with `edit` reshare it.
  // 0120: the agent's mark, chosen when it is made and changed in Configuration.
  // 0136: what the agent may not use (the browser, given connections), set
  // from Configuration's Tools switches by whoever may edit the agent.
  "agents INSERT":
    "avatar,browser_off,connections_off,created_by,emoji,mode,model,name,persona,reasoning_effort,temperature,web_search,workspace_access,workspace_id",
  "agents UPDATE":
    "avatar,browser_off,connections_off,emoji,mode,model,name,persona,reasoning_effort,temperature,web_search",
  // 0139: a person queues their own scan; the engine writes the rest. The
  // routine made from a bucket is the one thing they record on it.
  "arrival_buckets UPDATE": "routine_id",
  "arrival_scans INSERT": "sources,taxonomy,user_id,window_days,workspace_id",
  "api_keys INSERT": "name,prefix,token_hash,user_id,workspace_id",
  "api_keys UPDATE": "name,revoked_at",
  "capability_calls UPDATE": "status",
  "chat_sessions INSERT":
    "agent_id,kind,mode,model,reasoning_effort,title,user_id,visibility,web_search,workspace_id",
  "chat_sessions UPDATE": "mode,model,reasoning_effort,title,visibility,web_search",
  "connection_grants INSERT":
    "agent_id,capability,connection_id,granted_at,granted_by,mode,provider,workspace_id",
  "connection_grants UPDATE":
    "agent_id,capability,connection_id,granted_at,granted_by,mode,provider,workspace_id",
  "connections UPDATE": "status,sync_interval_minutes",
  "coverage_opt_outs INSERT": "created_at,user_id,workspace_id",
  "delivery_channels UPDATE": "label",
  // 0103: the generation a replacement writes its passages under.
  "document_chunks INSERT":
    "bundle_id,chunk_index,content,context,document_id,embedding,generation,workspace_id",
  // 0107: a rename carries the new name onto the passages' context.
  "document_chunks UPDATE": "bundle_id,context",
  // 0105: a new upload arrives queued for indexing.
  "documents INSERT": "bundle_id,content,created_by,index_status,name,r2_key,size",
  // 0107: a document can be renamed.
  "documents UPDATE": "bundle_id,name",
  "favorites INSERT": "agent_id,user_id",
  "feedback INSERT": "kind,message,message_id,path,user_id,workspace_id",
  "ideas INSERT":
    "created_by,detail,position,session_id,source_message_id,stage,title,workspace_id",
  "ideas UPDATE": "detail,position,stage,title,updated_at",
  // 0090: the token's hash added; status, expiry and acceptance taken away.
  // 0129: an admin makes a link with its hash and turns it off; nothing else.
  "invite_links INSERT": "created_by,role,token_hash,workspace_id",
  "invite_links UPDATE": "revoked_at",
  "invitations INSERT": "email,invited_by,role,token_hash,workspace_id",
  // 0106: private until shared.
  "knowledge_bundles INSERT": "created_by,description,name,scope,workspace_id",
  "knowledge_bundles UPDATE": "description,name,scope",
  // 0138: what the agent was told to keep in mind. Sharing is an UPDATE of
  // scope; the trigger allows only private to shared, and only by the author.
  "memory_notes INSERT": "about,created_by,scope,source,source_session_id,text,workspace_id",
  "memory_notes UPDATE": "scope,text,updated_at",
  // 0094 onwards: each table the columns the API writes with a caller's client.
  "messages INSERT": "content,role,sender_id,session_id",
  "messages UPDATE": "content",
  // 0128: the three "Email me when" switches.
  "notification_preferences INSERT":
    "needs_me_away,quota_exhausted,quota_warned_for,routine_failed,routine_paused,updated_at,user_id,weekly_summary",
  "notification_preferences UPDATE":
    "needs_me_away,quota_exhausted,quota_warned_for,routine_failed,routine_paused,updated_at,user_id,weekly_summary",
  "profiles UPDATE": "active_workspace_id,avatar_url,bio,locale,name,timezone",
  // 0123: whether runs land in the Inbox, and the model and thinking they run on.
  // 0130: the channels a routine delivers to after its primary.
  "routine_channels INSERT": "delivery_channel_id,routine_id",
  "routines INSERT":
    "agent_id,delivery_channel_id,deliver_inbox,ends_after_runs,instruction,model,name,next_run_at,output_bundle_id,output_retention,reasoning_effort,schedule_cron,source_config,source_kind,timezone,trigger_kind,user_id,visibility,workspace_id",
  "routines UPDATE":
    "browser_access,browser_site,consecutive_failures,delivery_channel_id,deliver_inbox,instruction,model,name,next_run_at,output_bundle_id,output_retention,paused_reason,reasoning_effort,schedule_cron,status,timezone,trigger_kind,updated_at,visibility",
  // 0121: when the caller last read a thread, upserted on (session_id, user_id).
  "session_reads INSERT": "last_read_at,session_id,user_id,workspace_id",
  "session_reads UPDATE": "last_read_at,session_id,user_id,workspace_id",
  "slack_installations UPDATE": "agent_id",
  "tool_connection_grants INSERT": "agent_id,granted_by,mode,slug,tool_connection_id,workspace_id",
  "tool_connection_grants UPDATE": "agent_id,mode,slug,tool_connection_id,workspace_id",
  "tool_connections UPDATE": "allowed_methods,config,label,scope",
  // 0119: the six columns an event is made of; id and created_at are defaults.
  "onboarding_events INSERT": "at,client_id,elapsed_ms,event,step,user_id",
  // 0119: the new first run's answers, the screen it was on, and what the
  // finish made — `finish_onboarding` is security invoker, so the caller's
  // own grant is what writes agent_id and session_id.
  // 0137: the first agent's mark and the jobs picked for it, the person's own row.
  "user_onboarding INSERT":
    "agent_id,assistant_avatar,assistant_emoji,assistant_jobs,assistant_name,assistant_role,completed_at,last_step,mode,purpose,referral_source,role,session_id,team_size,tools,updated_at,use_case,user_id",
  "user_onboarding UPDATE":
    "agent_id,assistant_avatar,assistant_emoji,assistant_jobs,assistant_name,assistant_role,completed_at,last_step,mode,purpose,referral_source,role,session_id,team_size,tools,updated_at,use_case,user_id",
  "workspace_members UPDATE": "role",
  // 0127: the icon, the clock and the weekly summary; never the deletion columns.
  // 0131: an admin's own client writes an endpoint; the sealed secret is
  // writable and never readable, and a delivery is the engine's alone.
  "webhook_endpoints INSERT": "created_by,events,secret_ciphertext,url,workspace_id",
  "webhook_endpoints UPDATE": "disabled_at,events,secret_ciphertext,updated_at,url",
  // 0132: an admin asks for an export in their own name; the engine does the rest.
  "workspace_exports INSERT": "requested_by,workspace_id",
  // 0135: an admin adds a model endpoint with its key sealed, and can rename
  // or remove it; the address and the key are never changed after the fact.
  "workspace_model_endpoints INSERT":
    "api_key_ciphertext,base_url,created_by,label,model,workspace_id",
  "workspace_model_endpoints UPDATE": "deleted_at,label",
  "workspaces UPDATE":
    "default_model,gap_report_enabled,icon_url,name,slug,timezone,weekly_usage_email",
};

afterAll(async () => {
  await closeSql();
});

describe("the anon role", () => {
  it("holds no table or sequence in public", async () => {
    const rows = (await sql()`
      select c.relname as name, c.relkind as kind
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'S', 'p')
         and (has_table_privilege('anon', c.oid, 'select, insert, update, delete, truncate, references, trigger')
              or (c.relkind = 'S' and has_sequence_privilege('anon', c.oid, 'usage, select, update')))
       order by 1`) as Array<{ name: string }>;
    expect(rows.map((r) => r.name)).toEqual([]);
  });

  it("can call no security definer function", async () => {
    // Trigger functions are exempt: Postgres refuses to call one directly.
    const rows = (await sql()`
      select p.oid::regprocedure::text as fn
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosecdef
         and p.prorettype <> 'trigger'::regtype
         and has_function_privilege('anon', p.oid, 'execute')
       order by 1`) as Array<{ fn: string }>;
    expect(rows.map((r) => r.fn)).toEqual([]);
  });
});

describe("the authenticated role", () => {
  it("may insert and update exactly the columns it may today", async () => {
    const rows = (await sql()`
      select c.relname as table, v.priv,
             string_agg(a.attname, ',' order by a.attname) as columns
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        cross join (values ('INSERT'), ('UPDATE')) v(priv)
       where n.nspname = 'public' and c.relkind = 'r'
         and has_column_privilege('authenticated', c.oid, a.attnum, v.priv)
       group by 1, 2`) as Array<{ table: string; priv: string; columns: string }>;

    const actual = new Map(
      rows.map((r) => [`${r.table} ${r.priv}`, new Set(r.columns.split(","))]),
    );
    const expected = new Map(
      Object.entries(AUTHENTICATED_WRITES).map(([k, v]) => [k, new Set(v.split(","))]),
    );

    const widened: string[] = [];
    for (const [key, columns] of actual) {
      for (const column of columns) {
        if (!expected.get(key)?.has(column)) widened.push(`${key}.${column}`);
      }
    }
    const narrowed: string[] = [];
    for (const [key, columns] of expected) {
      for (const column of columns) {
        if (!actual.get(key)?.has(column)) narrowed.push(`${key}.${column}`);
      }
    }

    expect(
      widened,
      "authenticated can now write these and could not before. A client role writing a " +
        "column is a decision: if it is meant, add it to AUTHENTICATED_WRITES with the " +
        "migration that grants it; if not, grant the columns the product writes and no more.",
    ).toEqual([]);
    expect(
      narrowed,
      "these grants were narrowed — good. Remove them from AUTHENTICATED_WRITES so the " +
        "ratchet holds the new line.",
    ).toEqual([]);
  });
});
