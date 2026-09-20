import { describe, it, expect } from "vitest";
import { parseCsv } from "./csv-preview";

describe("parseCsv", () => {
  it("reads the ordinary case", () => {
    expect(parseCsv("name,plan\nAcme,pro\nHooli,free")).toEqual([
      ["name", "plan"],
      ["Acme", "pro"],
      ["Hooli", "free"],
    ]);
  });

  // The two things that break a split on commas, which is the whole reason this
  // file exists rather than one line at the call site.
  it("keeps a delimiter inside a quoted field", () => {
    expect(parseCsv('name,note\nAcme,"Berlin, Germany"')).toEqual([
      ["name", "note"],
      ["Acme", "Berlin, Germany"],
    ]);
  });

  it("keeps a newline inside a quoted field", () => {
    expect(parseCsv('a,b\n"one\ntwo",three')).toEqual([
      ["a", "b"],
      ["one\ntwo", "three"],
    ]);
  });

  it("reads a doubled quote as one quote", () => {
    expect(parseCsv('a\n"she said ""no"""')).toEqual([["a"], ['she said "no"']]);
  });

  it("ends the last row on a trailing newline rather than inventing an empty one", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps empty cells, which are data", () => {
    expect(parseCsv("a,b,c\n1,,3")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
  });

  it("survives CRLF", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  // A 10 MB CSV is 100,000 rows the DOM should never be asked to draw.
  it("stops at the row cap", () => {
    const text = Array.from({ length: 500 }, (_, i) => `row-${i}`).join("\n");
    expect(parseCsv(text, 10)).toHaveLength(10);
  });

  it("answers an empty file with no rows", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("\n")).toEqual([]);
  });
});
