import { describe, it, expect, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useChecklistDismissed } from "./first-week";

/*
 * `useChecklistDismissed` reads `localStorage` during render rather than copying
 * it into state after mount (#68). These tests are about what that buys: the
 * workspace id arriving a render late still gets read, another tab is noticed,
 * and the flag stays per workspace.
 *
 * Every test uses its own workspace id. The hook keeps a module-level set of
 * dismissals made in this tab — the fallback for when the storage write throws —
 * and nothing exports a way to clear it, which is right for the product and
 * means tests must not share ids.
 */
let n = 0;
const nextId = () => `ws-${++n}`;

beforeEach(() => {
  localStorage.clear();
});

describe("useChecklistDismissed", () => {
  it("is not dismissed before the workspace id has arrived", () => {
    const { result } = renderHook(() => useChecklistDismissed(undefined));
    expect(result.current.dismissed).toBe(false);
  });

  it("reads a flag that was already stored", () => {
    const id = nextId();
    localStorage.setItem(`covan:first-week-dismissed:${id}`, "1");
    const { result } = renderHook(() => useChecklistDismissed(id));
    expect(result.current.dismissed).toBe(true);
  });

  it("reads the flag on the render the id shows up, with no effect in between", () => {
    // The case the old comment was about: `api.me()` answers a beat after the
    // first render. A lazy initialiser would have run against `undefined` and
    // never looked again; a snapshot function is called every render.
    const id = nextId();
    localStorage.setItem(`covan:first-week-dismissed:${id}`, "1");

    const { result, rerender } = renderHook(
      ({ workspaceId }: { workspaceId: string | undefined }) => useChecklistDismissed(workspaceId),
      { initialProps: { workspaceId: undefined as string | undefined } },
    );
    expect(result.current.dismissed).toBe(false);

    rerender({ workspaceId: id });
    expect(result.current.dismissed).toBe(true);
  });

  it("dismisses, and says so without a reload", () => {
    const id = nextId();
    const { result } = renderHook(() => useChecklistDismissed(id));
    expect(result.current.dismissed).toBe(false);

    act(() => result.current.dismiss());

    expect(result.current.dismissed).toBe(true);
    expect(localStorage.getItem(`covan:first-week-dismissed:${id}`)).toBe("1");
  });

  it("remembers per workspace, so a second setup is still nagged about", () => {
    const first = nextId();
    const second = nextId();
    localStorage.setItem(`covan:first-week-dismissed:${first}`, "1");

    expect(renderHook(() => useChecklistDismissed(first)).result.current.dismissed).toBe(true);
    expect(renderHook(() => useChecklistDismissed(second)).result.current.dismissed).toBe(false);
  });

  it("follows a dismissal made in another tab", () => {
    // What the effect this replaces never did: two tabs disagreed until one of
    // them was reloaded.
    const id = nextId();
    const { result } = renderHook(() => useChecklistDismissed(id));
    expect(result.current.dismissed).toBe(false);

    act(() => {
      localStorage.setItem(`covan:first-week-dismissed:${id}`, "1");
      window.dispatchEvent(new StorageEvent("storage"));
    });

    expect(result.current.dismissed).toBe(true);
  });

  it("still hides the checklist when storage refuses the write", () => {
    // Private mode, or a full quota. Dismissing has to work for the rest of the
    // session even though nothing can be written down for the next one.
    const id = nextId();
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    try {
      const { result } = renderHook(() => useChecklistDismissed(id));
      act(() => result.current.dismiss());
      expect(result.current.dismissed).toBe(true);
    } finally {
      Storage.prototype.setItem = setItem;
    }
  });

  it("treats a storage read that throws as not dismissed", () => {
    const id = nextId();
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("SecurityError");
    };
    try {
      const { result } = renderHook(() => useChecklistDismissed(id));
      expect(result.current.dismissed).toBe(false);
    } finally {
      Storage.prototype.getItem = getItem;
    }
  });
});
