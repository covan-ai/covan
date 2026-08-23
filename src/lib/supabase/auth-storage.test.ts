import { describe, it, expect, beforeEach } from "vitest";
import { authStorage, setRemember } from "./auth-storage";

// The key supabase-js derives from the project ref. Hard-coded here because the
// sweep in setRemember has to recognise it without being told.
const SESSION_KEY = "sb-abcdefgh-auth-token";

describe("the storage behind Remember me", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  // Nobody signed in before this flag existed has one. Defaulting to
  // sessionStorage would sign every one of them out the moment this ships.
  it("keeps the session in localStorage when nothing has answered yet", () => {
    authStorage.setItem(SESSION_KEY, "session");

    expect(window.localStorage.getItem(SESSION_KEY)).toBe("session");
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull();
    expect(authStorage.getItem(SESSION_KEY)).toBe("session");
  });

  it("keeps the session in localStorage when the box is checked", () => {
    setRemember(true);
    authStorage.setItem(SESSION_KEY, "session");

    expect(window.localStorage.getItem(SESSION_KEY)).toBe("session");
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it("confines the session to sessionStorage when the box is cleared", () => {
    setRemember(false);
    authStorage.setItem(SESSION_KEY, "session");

    expect(window.sessionStorage.getItem(SESSION_KEY)).toBe("session");
    expect(window.localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(authStorage.getItem(SESSION_KEY)).toBe("session");
  });

  // The point of clearing the box is that nothing survives the browser. A
  // refresh token left behind by an earlier remembered sign-in would.
  it("discards a remembered session when the box is cleared", () => {
    setRemember(true);
    authStorage.setItem(SESSION_KEY, "session");

    setRemember(false);

    expect(window.localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(authStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it("discards a tab-scoped session when the box is checked again", () => {
    setRemember(false);
    authStorage.setItem(SESSION_KEY, "session");

    setRemember(true);

    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull();
    expect(authStorage.getItem(SESSION_KEY)).toBeNull();
  });

  // Reading across both stores would resurrect the session the previous test
  // just established has to die.
  it("reads only the store the answer selected", () => {
    window.localStorage.setItem(SESSION_KEY, "remembered");
    setRemember(false);
    window.sessionStorage.setItem(SESSION_KEY, "tab-scoped");

    expect(authStorage.getItem(SESSION_KEY)).toBe("tab-scoped");
  });

  // signOut goes through removeItem, and it has to mean signed out of both.
  it("clears both stores on removal", () => {
    window.localStorage.setItem(SESSION_KEY, "session");
    window.sessionStorage.setItem(SESSION_KEY, "session");

    authStorage.removeItem(SESSION_KEY);

    expect(window.localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it("survives the answer being cleared and re-asked", () => {
    setRemember(false);
    setRemember(true);
    authStorage.setItem(SESSION_KEY, "session");

    expect(authStorage.getItem(SESSION_KEY)).toBe("session");
    expect(window.localStorage.getItem(SESSION_KEY)).toBe("session");
  });
});
