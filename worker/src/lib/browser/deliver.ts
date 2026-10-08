import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import type { BrowserTaskRow, FinishedTask } from "./poller";

/** Filled in by the next task. The signature is what `poller.ts` depends on. */
export async function deliverBrowserTask(
  _row: BrowserTaskRow,
  _outcome: FinishedTask,
  _env: RoutineEnv,
  _db: SupabaseClient,
): Promise<void> {}
