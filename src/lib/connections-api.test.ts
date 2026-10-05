import { describe, it, expect } from "vitest";
import {
  canConnectToolkit,
  mightConnectToolkit,
  type ComposioConnectKind,
  type ComposioToolkit,
} from "./connections-api";

/**
 * Whether a Connect button is offered, which until now had no test at all.
 *
 * It was `managedAuth || noAuth` — two columns of Composio's catalogue, which
 * between them prove two ways in. There is a third and it is most of the
 * catalogue: an application whose credential the person connecting supplies.
 * Every one of those 1,279 was told to go and register an OAuth client with a
 * provider that does not offer one.
 *
 * The two functions here are deliberately not the same question. One is the
 * answer and one is a hint, and the card sits unconditionally between the tile
 * and the button so that the hint being wrong costs a subtitle rather than an
 * error.
 */
function toolkit(over: Partial<ComposioToolkit> = {}): ComposioToolkit {
  return {
    slug: "gmail",
    name: "Gmail",
    description: "Mail",
    authSchemes: ["OAUTH2"],
    managedAuth: true,
    noAuth: false,
    connectKind: "managed_oauth",
    credentialScheme: "",
    authHintUrl: "",
    logoPath: "",
    categories: [],
    ...over,
  };
}

describe("canConnectToolkit", () => {
  const cases: Array<[ComposioConnectKind | null, boolean]> = [
    ["managed_oauth", true],
    ["no_auth", true],
    ["user_credential", true],
    ["needs_setup", false],
    [null, false],
  ];

  for (const [connectKind, expected] of cases) {
    it(`${expected ? "offers" : "refuses"} ${connectKind ?? "a row that could not say"}`, () => {
      expect(canConnectToolkit(toolkit({ connectKind }))).toBe(expected);
    });
  }

  it("reads the kind and not the two columns beneath it", () => {
    // The columns are what the old rule read, and they disagree with the
    // answer on most of the catalogue. If this ever starts passing on the
    // columns again, 1,279 applications have lost their button.
    expect(
      canConnectToolkit(
        toolkit({ connectKind: "user_credential", managedAuth: false, noAuth: false }),
      ),
    ).toBe(true);
    expect(
      canConnectToolkit(toolkit({ connectKind: "needs_setup", managedAuth: true, noAuth: true })),
    ).toBe(false);
  });
});

describe("mightConnectToolkit", () => {
  it("is optimistic about a credential scheme a list row can only hint at", () => {
    // A catalogue list row carries no field detail, so the answer is null and
    // only the scheme names are available. Showing "Needs setup in Composio"
    // on that is the thing being fixed.
    expect(
      mightConnectToolkit(
        toolkit({ connectKind: null, authSchemes: ["API_KEY"], managedAuth: false }),
      ),
    ).toBe(true);
    for (const scheme of ["BASIC", "BEARER_TOKEN", "api_key"]) {
      expect(
        mightConnectToolkit(
          toolkit({ connectKind: null, authSchemes: [scheme], managedAuth: false }),
        ),
      ).toBe(true);
    }
  });

  it("stays pessimistic about the fifty somebody really has to register", () => {
    expect(
      mightConnectToolkit(
        toolkit({ connectKind: null, authSchemes: ["OAUTH2"], managedAuth: false }),
      ),
    ).toBe(false);
    expect(
      mightConnectToolkit(
        toolkit({ connectKind: null, authSchemes: ["DCR_OAUTH"], managedAuth: false }),
      ),
    ).toBe(false);
  });

  it("never contradicts an answer it has", () => {
    // The hint may only ever be more generous, never less: a tile that says
    // setup is needed over a card that offers Connect is a surprise, and the
    // reverse would be a lie the card has to walk back.
    const kinds: Array<ComposioConnectKind | null> = [
      "managed_oauth",
      "no_auth",
      "user_credential",
      "needs_setup",
      null,
    ];
    for (const connectKind of kinds) {
      for (const authSchemes of [["OAUTH2"], ["API_KEY"], [], ["DCR_OAUTH", "BASIC"]]) {
        const t = toolkit({ connectKind, authSchemes });
        if (canConnectToolkit(t)) expect(mightConnectToolkit(t)).toBe(true);
      }
    }
  });
});
