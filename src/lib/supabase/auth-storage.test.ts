import { describe, it, expect, beforeEach } from "vitest";
import { authStorage, setRemember, adoptLegacyRemember } from "./auth-storage";

// The key supabase-js derives from the project ref. Hard-coded here because the
// sweep in setRemember has to recognise it without being told.
const SESSION_KEY = "sb-abcdefgh-auth-token";

/** Written out rather than imported, so a rename has to be a deliberate act. */
const REMEMBER_KEY = "covan.auth.remember";

/** What closing the tab does, and the only thing that distinguishes the stores. */
const closeTab = () => window.sessionStorage.clear();

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

/**
 * "Remember me" is a question asked on one form, about one sign-in. It was
 * being stored as a standing property of the machine instead: the flag sat in
 * localStorage, and nothing but another trip through a sign-in form with the
 * box ticked ever wrote it back.
 *
 * So a session created by a path that never asks — an email confirmation link,
 * a recovery link, anything supabase-js builds from the URL during
 * `detectSessionInUrl` — inherited an answer given weeks earlier and was
 * confined to the tab that opened the link. Nobody was asked and nothing said
 * so. See covan#187.
 *
 * The answer therefore lives in the store it describes: a cleared box writes it
 * to sessionStorage beside the session it applies to, and both die together.
 * Absent keeps meaning remembered, which is what an unasked path should get.
 */
describe("how long the answer lasts", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("does not let a cleared box outlive the tab that cleared it", () => {
    setRemember(false);
    authStorage.setItem(SESSION_KEY, "tab-scoped");
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBe("tab-scoped");

    closeTab();

    // A confirmation link opened later. Nothing asked, so it is remembered.
    authStorage.setItem(SESSION_KEY, "from a link");
    expect(window.localStorage.getItem(SESSION_KEY)).toBe("from a link");
    expect(authStorage.getItem(SESSION_KEY)).toBe("from a link");
  });

  it("still confines the session for as long as that tab is open", () => {
    setRemember(false);
    authStorage.setItem(SESSION_KEY, "tab-scoped");

    // A reload, not a new tab: the answer and the session are both still here.
    expect(authStorage.getItem(SESSION_KEY)).toBe("tab-scoped");
    expect(window.localStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it("spends the answer when the session it belongs to is signed out", () => {
    setRemember(false);
    authStorage.setItem(SESSION_KEY, "tab-scoped");

    authStorage.removeItem(SESSION_KEY);

    authStorage.setItem(SESSION_KEY, "signed in again");
    expect(window.localStorage.getItem(SESSION_KEY)).toBe("signed in again");
  });
});

/**
 * The upgrade itself, which is the dangerous part.
 *
 * Everyone who ever cleared the box is carrying `"false"` in localStorage right
 * now, with their session in sessionStorage. Simply reading the new location
 * would flip `active()` to localStorage, find nothing there, and sign that tab
 * out on the spot — the exact bug this file exists to prevent, shipped as the
 * fix for it.
 */
describe("taking over an answer the previous build wrote", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("keeps a tab signed in that answered no under the old build", () => {
    window.localStorage.setItem(REMEMBER_KEY, "false");
    window.sessionStorage.setItem(SESSION_KEY, "mid-session");

    adoptLegacyRemember();

    expect(authStorage.getItem(SESSION_KEY)).toBe("mid-session");
  });

  it("leaves nothing in localStorage for the next tab to inherit", () => {
    window.localStorage.setItem(REMEMBER_KEY, "false");
    window.sessionStorage.setItem(SESSION_KEY, "mid-session");

    adoptLegacyRemember();
    closeTab();

    authStorage.setItem(SESSION_KEY, "from a link");
    expect(window.localStorage.getItem(SESSION_KEY)).toBe("from a link");
  });

  it("drops a remembered answer too, since absent already means remembered", () => {
    window.localStorage.setItem(REMEMBER_KEY, "true");

    adoptLegacyRemember();

    expect(window.localStorage.getItem(REMEMBER_KEY)).toBeNull();
    authStorage.setItem(SESSION_KEY, "session");
    expect(window.localStorage.getItem(SESSION_KEY)).toBe("session");
  });

  it("does nothing when there is no old answer to take over", () => {
    window.sessionStorage.setItem(REMEMBER_KEY, "false");

    adoptLegacyRemember();

    expect(window.sessionStorage.getItem(REMEMBER_KEY)).toBe("false");
  });
});
