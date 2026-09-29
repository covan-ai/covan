import { describe, it, expect } from "vitest";
import type { Connection, ToolConnection } from "./connections-api";
import { mergeConnectedApps } from "./connected-apps";

const tool = (over: Partial<ToolConnection> & { id: string }): ToolConnection => ({
  label: "Gmail",
  transport: "composio",
  baseUrl: "",
  allowedMethods: ["GET"],
  summary: null,
  rpc: null,
  toolkitSlug: "gmail",
  status: "active",
  logoPath: "/composio/logo?u=gmail",
  createdAt: 0,
  ...over,
});

const source = (over: Partial<Connection> & { id: string }): Connection => ({
  provider: "notion",
  accountLabel: "Northwind",
  bundleId: "b1",
  bundleName: "Team",
  userId: "u1",
  status: "active",
  pausedReason: null,
  pausedCode: null,
  needsFolder: false,
  folderName: null,
  syncIntervalMinutes: 60,
  nextSyncAt: null,
  lastSyncAt: null,
  documentCount: 3,
  createdAt: 0,
  ...over,
});

const names = (apps: { name: string }[]) => apps.map((a) => a.name);

describe("mergeConnectedApps", () => {
  it("has nothing to offer a workspace that connected nothing", () => {
    expect(mergeConnectedApps([], [])).toEqual([]);
  });

  /**
   * What counts as connected, which is a narrower question than what exists.
   * The empty screen offers a sentence per app, and a sentence about an app
   * that cannot answer is worse than one line less.
   */
  it("leaves out an app somebody is still away at a consent screen for", () => {
    // `pending` means the grant is half-made. A starter built on it produces a
    // failing tool call as the user's first experience of the agent.
    const apps = mergeConnectedApps([tool({ id: "t1", status: "pending" })], []);
    expect(apps).toEqual([]);
  });

  it("leaves out an app whose grant failed", () => {
    expect(mergeConnectedApps([tool({ id: "t1", status: "failed" })], [])).toEqual([]);
  });

  it("keeps a paused source, because its documents are still there", () => {
    // A pause stops new documents arriving. It does not un-index the ones
    // already read, and those are still quotable — so the offer stands.
    const apps = mergeConnectedApps([], [source({ id: "c1", status: "paused" })]);
    expect(names(apps)).toEqual(["Notion"]);
  });

  it("leaves out a Drive that has never been pointed at a folder", () => {
    // `needsFolder` means the grant exists and nothing has synced. There is no
    // content behind an offer to search it — failure mode #1, a claim the code
    // cannot back.
    const apps = mergeConnectedApps(
      [],
      [source({ id: "c1", provider: "google_drive", needsFolder: true })],
    );
    expect(apps).toEqual([]);
  });

  it("keeps a Drive once it has a folder", () => {
    const apps = mergeConnectedApps(
      [],
      [source({ id: "c1", provider: "google_drive", needsFolder: false })],
    );
    expect(names(apps)).toEqual(["Google Drive"]);
  });

  it("ignores a connection to something that is not an application", () => {
    // `http` and `sql` connections are a REST API and a Postgres. They have no
    // mark, no product name, and nothing a generic sentence could truthfully
    // say about them.
    const apps = mergeConnectedApps(
      [
        tool({ id: "t1", transport: "http", toolkitSlug: null, label: "Internal API" }),
        tool({ id: "t2", transport: "sql", toolkitSlug: null, label: "Warehouse" }),
      ],
      [],
    );
    expect(apps).toEqual([]);
  });

  it("counts a workspace's Slack among the apps it can call", () => {
    // Distinct from the Slack an answer is DELIVERED to, which is not a
    // connection at all and never appears here. One of these is a place to ask
    // a question; the other is a place an answer arrives.
    const apps = mergeConnectedApps([tool({ id: "t1", toolkitSlug: "slack", label: "Slack" })], []);
    expect(names(apps)).toEqual(["Slack"]);
  });

  /** One application, one row, however many ways it reached us. */
  it("shows Notion once when it is both a source and a connected app", () => {
    const apps = mergeConnectedApps(
      [tool({ id: "t1", toolkitSlug: "notion", label: "Notion", logoPath: "/logo?u=notion" })],
      [source({ id: "c1", provider: "notion" })],
    );
    expect(apps).toHaveLength(1);
    // Composio wins: the reconciler's half is already represented by the
    // documents it synced, which the Knowledge group above offers separately.
    expect(apps[0].logoPath).toBe("/logo?u=notion");
    expect(apps[0].provider).toBeNull();
  });

  it("shows Drive once, across the two names the two systems give it", () => {
    const apps = mergeConnectedApps(
      [tool({ id: "t1", toolkitSlug: "googledrive", label: "googledrive" })],
      [source({ id: "c1", provider: "google_drive" })],
    );
    expect(apps).toHaveLength(1);
    expect(apps[0].name).toBe("Google Drive");
  });

  /**
   * What each row is called. Three branches, because the raw slug reaches the
   * screen far more often than it looks: the worker falls back to it when
   * nobody typed a label, so `label` can legitimately read "gmail".
   */
  it("prefers the product's name over whatever the row was labelled", () => {
    const apps = mergeConnectedApps(
      [tool({ id: "t1", toolkitSlug: "googledrive", label: "Marketing files" })],
      [],
    );
    expect(names(apps)).toEqual(["Google Drive"]);
  });

  it("uses a person's own label for an app we have no name for", () => {
    const apps = mergeConnectedApps(
      [tool({ id: "t1", toolkitSlug: "acme_crm", label: "Acme CRM" })],
      [],
    );
    expect(names(apps)).toEqual(["Acme CRM"]);
  });

  it("falls back to the slug when the label is only the slug again", () => {
    const apps = mergeConnectedApps(
      [tool({ id: "t1", toolkitSlug: "linear", label: "linear" })],
      [],
    );
    expect(names(apps)).toEqual(["Linear"]);
  });

  it("falls back to the slug when there is no label at all", () => {
    const apps = mergeConnectedApps([tool({ id: "t1", toolkitSlug: "linear", label: "" })], []);
    expect(names(apps)).toEqual(["Linear"]);
  });

  /** A grid that reshuffles when an unrelated connection is added is a bug. */
  it("orders by slug, so adding one app does not move the others", () => {
    const before = mergeConnectedApps(
      [
        tool({ id: "t1", toolkitSlug: "slack", label: "Slack" }),
        tool({ id: "t2", toolkitSlug: "gmail", label: "Gmail" }),
      ],
      [],
    );
    const after = mergeConnectedApps(
      [
        tool({ id: "t3", toolkitSlug: "linear", label: "Linear" }),
        tool({ id: "t1", toolkitSlug: "slack", label: "Slack" }),
        tool({ id: "t2", toolkitSlug: "gmail", label: "Gmail" }),
      ],
      [],
    );
    expect(names(before)).toEqual(["Gmail", "Slack"]);
    expect(names(after)).toEqual(["Gmail", "Linear", "Slack"]);
  });

  it("marks a source we draw ourselves, so the chip knows not to fetch one", () => {
    const apps = mergeConnectedApps([], [source({ id: "c1", provider: "notion" })]);
    expect(apps[0].provider).toBe("notion");
    expect(apps[0].logoPath).toBe("");
  });

  it("does not repeat one application because two people connected it", () => {
    const apps = mergeConnectedApps(
      [
        tool({ id: "t1", toolkitSlug: "gmail", label: "Gmail" }),
        tool({ id: "t2", toolkitSlug: "gmail", label: "Gmail (support)" }),
      ],
      [],
    );
    expect(apps).toHaveLength(1);
  });
});
