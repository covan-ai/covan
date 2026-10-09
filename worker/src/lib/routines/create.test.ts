import { describe, expect, it } from "vitest";
import { createRoutine, type CreateRoutineInput } from "./create";
import { fakeDb } from "../../test-support/fake-db";

/**
 * `createRoutine` is the one insert site — `POST /routines` and the
 * `schedule_job` agent tool both land here, per this module's own header —
 * but until task 17, nothing ever called it for `sourceKind: "workspace"`.
 * Every fixture that built a `workspace` row (`tests/rls/coverage-gaps.test.ts`,
 * `executor.test.ts`) hand-built it directly, and the dialog's `canSave` kept
 * the one UI path to it permanently disabled. So this is the first test that
 * drives this function itself for that kind, rather than a row shaped by hand
 * to look like what it would have produced.
 */
describe('createRoutine, sourceKind "workspace"', () => {
  const INPUT: CreateRoutineInput = {
    agentId: "agent-1",
    workspaceId: "workspace-1",
    userId: "user-1",
    name: "Coverage gaps",
    sourceKind: "workspace",
    instruction: "report the gaps",
    deliveryChannelId: "channel-1",
    scheduleCron: "0 9 * * 1",
    timezone: "UTC",
  };

  it('writes source_kind "workspace" and a source_config.report the CHECK accepts', async () => {
    const { db, callsTo } = fakeDb({
      tables: {
        routines: {
          insert: (ctx) => ({ data: { id: "routine-1", ...ctx.values }, error: null }),
        },
      },
    });

    const result = await createRoutine(db as never, INPUT, []);

    expect(result.ok).toBe(true);
    const inserted = callsTo("routines")[0].values!;
    expect(inserted.source_kind).toBe("workspace");

    // 0075's `routines_workspace_config_check`:
    //   coalesce(source_config ->> 'report', '') ~ '^[a-z][a-z0-9_]{0,63}$'
    // Matched against the real pattern, not just equality, so a value the
    // database CHECK would itself refuse fails here too, not only on a live run.
    const report = (inserted.source_config as Record<string, unknown>).report;
    expect(report).toBe("coverage_gaps");
    expect(String(report)).toMatch(/^[a-z][a-z0-9_]{0,63}$/);

    // 0075's other CHECK on this kind — output_bundle_id must be null — and
    // visibility is left for the column's own `private` default rather than
    // set here, so both are satisfied without this function knowing why.
    expect(inserted.output_bundle_id).toBeNull();
    expect(inserted).not.toHaveProperty("visibility");
  });
});
