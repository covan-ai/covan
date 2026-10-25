import { describe, expect, it } from "vitest";
import * as worker from "../../worker/src/lib/arrivals/taxonomy";
import { ARRIVAL_KINDS, KIND_NAME, PROPOSAL_FOR, UNANSWERED_KINDS } from "./arrivals";

describe("the frontend's copy of the taxonomy", () => {
  it("has the worker's ids, in the worker's order", () => {
    expect([...ARRIVAL_KINDS]).toEqual([...worker.KINDS]);
  });

  it("proposes what the worker proposes", () => {
    expect(PROPOSAL_FOR).toEqual(worker.PROPOSAL_FOR);
    expect([...UNANSWERED_KINDS].sort()).toEqual([...worker.UNANSWERED_KINDS].sort());
  });

  it("names every kind the way the report shows it", () => {
    expect(KIND_NAME.question).toBe("Questions to you");
    expect(KIND_NAME.admin).toBe("Invoices, payments and admin");
    expect(Object.keys(KIND_NAME)).toHaveLength(10);
  });
});
