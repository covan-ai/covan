import { describe, it, expect } from "vitest";
import {
  accessRank,
  canEditAgent,
  canManageAgent,
  cappedByRole,
  newAgentSharing,
  sharingFor,
  sharingMode,
  sharingSummary,
  deleteSummarySentence,
  whoCanEdit,
  whoCanUse,
  type AgentSharing,
} from "./agent-access";

describe("the levels", () => {
  it("rank in the order the database ranks them", () => {
    expect(accessRank(null)).toBe(0);
    expect(accessRank("use")).toBe(1);
    expect(accessRank("edit")).toBe(2);
    expect(accessRank("manage")).toBe(3);
  });

  it("let Can edit and Full access change an agent, and only Full access share it", () => {
    expect(canEditAgent({ myAccess: "use" })).toBe(false);
    expect(canEditAgent({ myAccess: "edit" })).toBe(true);
    expect(canEditAgent({ myAccess: "manage" })).toBe(true);
    expect(canManageAgent({ myAccess: "edit" })).toBe(false);
    expect(canManageAgent({ myAccess: "manage" })).toBe(true);
  });

  it("cap a viewer at Can use, and nobody else", () => {
    expect(cappedByRole("viewer", "edit")).toBe(true);
    expect(cappedByRole("viewer", "use")).toBe(false);
    expect(cappedByRole("member", "manage")).toBe(false);
  });
});

describe("the three ways to reach an agent", () => {
  it("are read off the workspace level first, then the list", () => {
    expect(sharingMode({ workspaceAccess: null, shares: [] })).toBe("only");
    expect(sharingMode({ workspaceAccess: null, shares: [{ userId: "u2", access: "use" }] })).toBe(
      "people",
    );
    expect(
      sharingMode({ workspaceAccess: "use", shares: [{ userId: "u2", access: "edit" }] }),
    ).toBe("workspace");
  });

  it("send no list for Only me, and no workspace level for specific people", () => {
    const shares = [{ userId: "u2", access: "edit" as const }];
    expect(sharingFor("only", "edit", shares)).toEqual({ workspaceAccess: null, shares: [] });
    expect(sharingFor("people", "edit", shares)).toEqual({ workspaceAccess: null, shares });
    expect(sharingFor("workspace", "use", shares)).toEqual({ workspaceAccess: "use", shares });
  });

  it("start a new agent on Only me unless the workspace is picked", () => {
    expect(newAgentSharing("only")).toEqual({ workspaceAccess: null, shares: [] });
    expect(newAgentSharing("edit")).toEqual({ workspaceAccess: "edit", shares: [] });
  });
});

describe("sharingSummary", () => {
  const base = { createdBy: "u1", workspaceAccess: null, shares: [] };

  it("says Only you to the owner, and Only the owner to an admin looking at it", () => {
    expect(sharingSummary(base, "u1").label).toBe("Only you");
    expect(sharingSummary(base, "u9").label).toBe("Only the owner");
  });

  it("counts people, and names the level everyone has", () => {
    expect(sharingSummary({ ...base, shares: [{ userId: "u2", access: "use" }] }, "u1").label).toBe(
      "1 person",
    );
    expect(sharingSummary({ ...base, workspaceAccess: "edit" }, "u1").label).toBe(
      "Everyone · Can edit",
    );
  });
});

describe("deleteSummarySentence", () => {
  it("says what goes, what stops and what stays", () => {
    expect(deleteSummarySentence({ threads: 19, routines: 2, folders: 3 })).toBe(
      "Its 19 threads stay readable for 30 days under Recently deleted, then go. The 2 routines pointed at it stop now. The 3 folders it reads are not touched.",
    );
    expect(deleteSummarySentence({ threads: 1, routines: 1, folders: 0 })).toBe(
      "Its 1 thread stays readable for 30 days under Recently deleted, then goes. The 1 routine pointed at it stops now.",
    );
    expect(deleteSummarySentence({ threads: 0, routines: 0, folders: 0 })).toBe(
      "It waits 30 days under Recently deleted, then goes.",
    );
  });
});

describe("whoCanUse and whoCanEdit", () => {
  const base: AgentSharing & { createdBy: string | null } = {
    createdBy: "u1",
    workspaceAccess: null,
    shares: [],
  };
  const names: Record<string, string> = { u1: "Mina Kaya", u2: "Deniz Arslan" };
  const nameOf = (id: string) => names[id] ?? null;

  it("names the workspace when everyone may", () => {
    expect(whoCanUse({ ...base, workspaceAccess: "use" }, "Acme", "u1")).toBe("Everyone in Acme");
    expect(whoCanEdit({ ...base, workspaceAccess: "edit" }, "Acme", nameOf, "u2")).toBe(
      "Everyone in Acme",
    );
  });

  it("says admins and who else may edit", () => {
    expect(whoCanEdit({ ...base }, "Acme", nameOf, "u2")).toBe("Admins and Mina");
    expect(
      whoCanEdit({ ...base, shares: [{ userId: "u2", access: "edit" }] }, "Acme", nameOf, "u1"),
    ).toBe("Admins and you and Deniz");
    expect(whoCanUse({ ...base }, "Acme", "u1")).toBe("Only you");
  });
});
