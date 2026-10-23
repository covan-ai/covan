import { describe, expect, it } from "vitest";
import {
  LOCALE_COOKIE,
  formattingLocale,
  isLocaleTag,
  parseAcceptLanguage,
  pickLocale,
  readCookie,
  uiLanguage,
} from "./locale";

describe("isLocaleTag", () => {
  it("accepts the shapes the profiles.locale check accepts", () => {
    for (const tag of ["en", "tr", "tr-TR", "en-GB", "pt-BR", "zh-Hant-TW", "ast"]) {
      expect(isLocaleTag(tag), tag).toBe(true);
    }
  });

  it("refuses anything that could not be a tag", () => {
    for (const bad of ["", "e", "english", "tr_TR", "en-", "<script>", "tr-TR;q=0.9", "en GB"]) {
      expect(isLocaleTag(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("parseAcceptLanguage", () => {
  it("orders by q, keeping the header's order for ties", () => {
    expect(parseAcceptLanguage("tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7")).toEqual([
      "tr-TR",
      "tr",
      "en-US",
      "en",
    ]);
    expect(parseAcceptLanguage("en;q=0.5, tr")).toEqual(["tr", "en"]);
  });

  it("drops the wildcard, malformed entries and an absent header", () => {
    expect(parseAcceptLanguage("*")).toEqual([]);
    expect(parseAcceptLanguage("de;q=abc, fr;q=0")).toEqual(["de"]);
    expect(parseAcceptLanguage(undefined)).toEqual([]);
    expect(parseAcceptLanguage("")).toEqual([]);
  });
});

describe("readCookie", () => {
  it("finds the one cookie among several", () => {
    const header = `theme=dark; ${LOCALE_COOKIE}=tr-TR; sb=abc%3Ddef`;
    expect(readCookie(header, LOCALE_COOKIE)).toBe("tr-TR");
    expect(readCookie(header, "theme")).toBe("dark");
    expect(readCookie(header, "sb")).toBe("abc=def");
  });

  it("does not match a cookie whose name merely ends the same way", () => {
    expect(readCookie(`x-${LOCALE_COOKIE}=de`, LOCALE_COOKIE)).toBeUndefined();
    expect(readCookie(undefined, LOCALE_COOKIE)).toBeUndefined();
    expect(readCookie("", LOCALE_COOKIE)).toBeUndefined();
  });
});

describe("pickLocale", () => {
  it("prefers a valid cookie over the browser", () => {
    expect(pickLocale({ cookie: "tr", acceptLanguage: "en-US,en;q=0.9" })).toBe("tr");
  });

  it("ignores a cookie that is not a tag", () => {
    expect(pickLocale({ cookie: "<b>", acceptLanguage: "en-US,en;q=0.9" })).toBe("en-US");
  });

  it("takes the first browser language the interface has, keeping its region", () => {
    expect(pickLocale({ acceptLanguage: "de-DE,de;q=0.9,tr-TR;q=0.8,en;q=0.7" })).toBe("tr-TR");
    expect(pickLocale({ acceptLanguage: "en-US,en;q=0.9" })).toBe("en-US");
  });

  it("falls back to English when the browser offers nothing the interface has", () => {
    expect(pickLocale({ acceptLanguage: "de-DE,fr;q=0.8" })).toBe("en");
    expect(pickLocale({})).toBe("en");
  });

  // A stored preference may be any tag the API accepts, which is wider than
  // the languages the interface has. It is still the person's choice of
  // formatting, and the catalogue falls back to English on its own.
  it("keeps a cookie for a language the interface does not have", () => {
    expect(pickLocale({ cookie: "de-DE" })).toBe("de-DE");
  });
});

describe("uiLanguage", () => {
  it("maps any tag to one of the catalogues", () => {
    expect(uiLanguage("tr")).toBe("tr");
    expect(uiLanguage("tr-TR")).toBe("tr");
    expect(uiLanguage("TR-tr")).toBe("tr");
    expect(uiLanguage("en-US")).toBe("en");
    expect(uiLanguage("de-DE")).toBe("en");
    expect(uiLanguage("")).toBe("en");
  });
});

describe("formattingLocale", () => {
  // The interface has always formatted dates the British way (22 October, not
  // October 22); a bare "en" must keep doing that rather than drift to en-US.
  it("gives a bare language its established region", () => {
    expect(formattingLocale("en")).toBe("en-GB");
    expect(formattingLocale("tr")).toBe("tr-TR");
  });

  it("leaves a full tag alone", () => {
    expect(formattingLocale("en-US")).toBe("en-US");
    expect(formattingLocale("tr-CY")).toBe("tr-CY");
    expect(formattingLocale("de-DE")).toBe("de-DE");
  });
});
