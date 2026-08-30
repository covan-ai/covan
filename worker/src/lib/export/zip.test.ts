import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeZip, type ZipEntry } from "./zip";

/**
 * Checked against `unzip`, not against a second reader written here.
 *
 * A hand-rolled format tested only by its own parser proves the two agree and
 * nothing else — and the thing that matters about this archive is that software
 * nobody in this repository wrote can open it, five years from now, on a
 * machine that has never heard of Covan. `unzip -t` verifies every CRC, which
 * is exactly the field a hand-rolled writer gets wrong.
 */
beforeAll(() => {
  for (const [bin, args] of [
    ["unzip", ["-v"]],
    ["python3", ["--version"]],
  ] as const) {
    try {
      execFileSync(bin, args, { stdio: "ignore" });
    } catch {
      throw new Error(
        `These tests need \`${bin}\` on PATH. Two readers rather than one: ` +
          `unzip verifies the CRCs, and Python's zipfile is old enough to be ` +
          `everywhere and new enough to know about the UTF-8 flag, which the ` +
          `unzip macOS ships does not.`,
      );
    }
  }
});

async function zip(entries: ZipEntry[]): Promise<Uint8Array> {
  async function* iter() {
    for (const e of entries) yield e;
  }
  const chunks: Uint8Array[] = [];
  const reader = writeZip(iter()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function onDisk(bytes: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), "covan-zip-"));
  const path = join(dir, "archive.zip");
  writeFileSync(path, bytes);
  return path;
}

const text = (s: string) => new TextEncoder().encode(s);

describe("the archive", () => {
  it("passes unzip's own integrity check", async () => {
    const path = onDisk(
      await zip([
        { name: "manifest.json", data: text('{"format":1}') },
        { name: "data/agents.json", data: text("[]") },
      ]),
    );

    // -t verifies every entry's CRC against its bytes. This is the assertion
    // the whole file exists for.
    const out = execFileSync("unzip", ["-t", path], { encoding: "utf8" });
    expect(out).toMatch(/No errors detected in compressed data/);
  });

  it("gives back exactly the bytes it was given", async () => {
    const body = '{"rows":[{"id":"a"},{"id":"b"}]}';
    const path = onDisk(await zip([{ name: "data/agents.json", data: text(body) }]));

    const out = execFileSync("unzip", ["-p", path, "data/agents.json"], { encoding: "utf8" });
    expect(out).toBe(body);
  });

  it("survives arbitrary binary, which is what an uploaded document is", async () => {
    // Every byte value, including the ones that look like ZIP signatures.
    const bytes = new Uint8Array(256 * 4);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const path = onDisk(await zip([{ name: "documents/blob.bin", data: bytes }]));

    const dir = join(path, "..");
    execFileSync("unzip", ["-o", "-q", path, "-d", dir]);
    expect(new Uint8Array(readFileSync(join(dir, "documents/blob.bin")))).toEqual(bytes);
  });

  it("keeps a non-ASCII filename intact", async () => {
    // The reason bit 11 is set. Without it the name comes back mojibake, and
    // the person who notices is the one whose language is not English.
    //
    // Checked with Python's zipfile rather than with `unzip`, and the reason is
    // worth recording: the Info-ZIP build macOS still ships is from 2005 and
    // predates the UTF-8 flag entirely, so it transliterates the name and then
    // refuses to create the file. That is a limitation of a twenty-year-old
    // tool, not of the archive — anything that has heard of bit 11 reads it
    // correctly, and this proves which of the two it is.
    const name = "documents/toplantı-notları.md";
    const path = onDisk(await zip([{ name, data: text("merhaba") }]));

    const out = execFileSync(
      "python3",
      [
        "-c",
        "import sys,zipfile\n" +
          "z=zipfile.ZipFile(sys.argv[1])\n" +
          "i=z.infolist()[0]\n" +
          "print(i.filename)\n" +
          "print(i.flag_bits & 0x800)\n" +
          "print(z.read(i).decode())",
        path,
      ],
      { encoding: "utf8" },
    ).split("\n");

    expect(out[0]).toBe(name);
    expect(out[1]).toBe("2048"); // the UTF-8 flag, set
    expect(out[2]).toBe("merhaba");
  });

  it("writes an empty archive that is still a well-formed one", async () => {
    // A workspace with nothing in it is a real thing to export, and an archive
    // with no entries is where a hand-rolled EOCD is most likely to be wrong.
    //
    // Info-ZIP calls a zero-entry archive empty and exits non-zero, which is
    // its opinion rather than a defect — the 22-byte EOCD is exactly what the
    // specification asks for, and it says so instead of choking. Asserted as
    // the behaviour it is. In practice the export never produces one: the
    // manifest is always written.
    const path = onDisk(await zip([]));
    expect(readFileSync(path).length).toBe(22);

    try {
      execFileSync("unzip", ["-l", path], { encoding: "utf8", stdio: "pipe" });
      throw new Error("expected unzip to complain about an empty archive");
    } catch (e) {
      expect(String((e as { stderr?: string }).stderr ?? e)).toMatch(/zipfile is empty/);
    }
  });

  it("holds many entries, in the order they were written", async () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({
      name: `data/part-${String(i).padStart(3, "0")}.json`,
      data: text(String(i)),
    }));
    const path = onDisk(await zip(entries));

    const listed = execFileSync("unzip", ["-Z", "-1", path], { encoding: "utf8" })
      .trim()
      .split("\n");
    expect(listed).toEqual(entries.map((e) => e.name));
  });

  it("is byte-identical when the same workspace is exported twice", async () => {
    // No clock in the headers, so two exports of unchanged data can be diffed
    // or hashed and the answer means something.
    const entries = [{ name: "manifest.json", data: text('{"format":1}') }];
    expect(await zip(entries)).toEqual(await zip(entries));
  });
});

describe("the limits it will not silently cross", () => {
  it("refuses past 65,535 entries rather than wrapping the count", async () => {
    async function* many() {
      for (let i = 0; i <= 65535; i++) yield { name: `f${i}`, data: new Uint8Array(0) };
    }
    const reader = writeZip(many()).getReader();
    await expect(
      (async () => {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      })(),
    ).rejects.toThrow(/Zip64/);
  });

  it("refuses past 4 GB rather than wrapping the offsets", async () => {
    // The bytes are never allocated: the guard reads `.length` and fires before
    // anything touches the buffer, which is also why a stand-in with only that
    // property is enough to reach it.
    async function* huge() {
      yield { name: "a", data: { length: 0x100000000 } as unknown as Uint8Array };
    }
    const reader = writeZip(huge()).getReader();
    await expect(
      (async () => {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      })(),
    ).rejects.toThrow(/4 GB/);
  });
});
