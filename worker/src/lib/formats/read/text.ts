/**
 * Turning bytes and markup into plain text.
 *
 * Everything here is pure and synchronous, and runs the same on Workers and on
 * Node: no `TextDecoder` label beyond `utf-8`, which is the one every runtime
 * is guaranteed to have, and no DOM.
 */

/**
 * Text from a file's bytes, whatever encoding it was saved in.
 *
 * Decoding everything as UTF-8 was the old rule, and it cost the two files a
 * Turkish office most often has. A text file saved by older Windows software is
 * Windows-1254: decoded as UTF-8 every ğ, ş and ı became a replacement mark,
 * about one character in seven, which passed the "is this text" check and was
 * embedded garbled. And Excel's "Unicode text" export is UTF-16, which is full
 * of NUL bytes and was refused as a binary file.
 *
 * So: a byte-order mark decides when there is one. Otherwise the bytes are
 * tried as strict UTF-8, and if they are not valid UTF-8 they are read as
 * Windows-1254 — a superset of what a Western European file needs, and the
 * right answer for a Turkish one. A UTF-16 file without a mark is recognised by
 * its pattern of zero bytes.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder().decode(bytes.subarray(3));
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return decodeUtf16(bytes.subarray(2), true);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return decodeUtf16(bytes.subarray(2), false);

  const sixteen = utf16Without(bytes);
  if (sixteen) return decodeUtf16(bytes, sixteen === "le");

  try {
    // `stream: true` keeps a sequence cut off at the end of a range read from
    // counting as invalid: it is held back rather than thrown on.
    return new TextDecoder("utf-8", { fatal: true } as TextDecoderConstructorOptions).decode(
      bytes,
      { stream: true },
    );
  } catch {
    return decodeWindows1254(bytes);
  }
}

/** "le" or "be" when the bytes look like UTF-16 with no mark, else null. */
function utf16Without(bytes: Uint8Array): "le" | "be" | null {
  const sample = Math.min(bytes.length, 4096) & ~1;
  if (sample < 4) return null;
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < sample; i += 2) {
    if (bytes[i] === 0) evenZero++;
    if (bytes[i + 1] === 0) oddZero++;
  }
  const pairs = sample / 2;
  // ASCII-heavy UTF-16 has a zero in one half of nearly every pair and almost
  // none in the other. Real UTF-8 or single-byte text has no zeros at all.
  if (oddZero / pairs > 0.3 && evenZero / pairs < 0.05) return "le";
  if (evenZero / pairs > 0.3 && oddZero / pairs < 0.05) return "be";
  return null;
}

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
  const units = Math.floor(bytes.length / 2);
  const parts: string[] = [];
  const CHUNK = 8192;
  for (let start = 0; start < units; start += CHUNK) {
    const end = Math.min(units, start + CHUNK);
    const codes = new Array<number>(end - start);
    for (let i = start; i < end; i++) {
      const a = bytes[i * 2];
      const b = bytes[i * 2 + 1];
      codes[i - start] = littleEndian ? a | (b << 8) : (a << 8) | b;
    }
    parts.push(String.fromCharCode(...codes));
  }
  return parts.join("");
}

/**
 * Windows-1254 for 0x80–0xFF. Latin-1 everywhere except the 0x80–0x9F block
 * (Windows punctuation) and the six Turkish letters at D0, DD, DE, F0, FD, FE.
 */
const CP1254_HIGH: Record<number, number> = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x0192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x02c6,
  0x89: 0x2030,
  0x8a: 0x0160,
  0x8b: 0x2039,
  0x8c: 0x0152,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x02dc,
  0x99: 0x2122,
  0x9a: 0x0161,
  0x9b: 0x203a,
  0x9c: 0x0153,
  0x9f: 0x0178,
  0xd0: 0x011e,
  0xdd: 0x0130,
  0xde: 0x015e,
  0xf0: 0x011f,
  0xfd: 0x0131,
  0xfe: 0x015f,
};

export function decodeWindows1254(bytes: Uint8Array): string {
  const parts: string[] = [];
  const CHUNK = 8192;
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const end = Math.min(bytes.length, start + CHUNK);
    const codes = new Array<number>(end - start);
    for (let i = start; i < end; i++) {
      const b = bytes[i];
      codes[i - start] = b < 0x80 ? b : (CP1254_HIGH[b] ?? (b >= 0xa0 ? b : 0xfffd));
    }
    parts.push(String.fromCharCode(...codes));
  }
  return parts.join("");
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  deg: "°",
  times: "×",
  divide: "÷",
  ccedil: "ç",
  Ccedil: "Ç",
  ouml: "ö",
  Ouml: "Ö",
  uuml: "ü",
  Uuml: "Ü",
  auml: "ä",
  Auml: "Ä",
  eacute: "é",
  Eacute: "É",
  egrave: "è",
  agrave: "à",
  aacute: "á",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  ntilde: "ñ",
  szlig: "ß",
};

/** `&amp;`, `&#305;`, `&#x131;` and the common named entities, decoded. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED[body] ?? whole;
  });
}

/** Runs of blank lines and trailing spaces, tidied. */
export function tidy(s: string): string {
  return s
    .replace(/[ \t\u00a0]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The readable text of an HTML page, with its headings kept as Markdown.
 *
 * Scripts, styles and comments go entirely; block elements become line breaks
 * so paragraphs stay paragraphs and the chunker can find their edges.
 */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|template|svg)[\s>][\s\S]*?<\/\1>/gi, "")
    .replace(/<head[\s>][\s\S]*?<\/head>/i, (head) => {
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1]?.trim();
      return title ? `# ${title}\n\n` : "";
    });
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
    const text = inner.replace(/<[^>]+>/g, "").trim();
    return text ? `\n\n${"#".repeat(Number(level))} ${text}\n\n` : "";
  });
  s = s
    .replace(/<li[\s>]/gi, "\n- $&")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(
      /<\/(p|div|section|article|li|tr|table|ul|ol|blockquote|pre|header|footer|main|nav)>/gi,
      "\n",
    )
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, "");
  return tidy(decodeEntities(s).replace(/\n- +\n/g, "\n- "));
}

/**
 * The text of an RTF document.
 *
 * Not a parser: a sweep that drops the destinations which are never text (font
 * and colour tables, stylesheets, document info, pictures), turns paragraph
 * marks into newlines, and decodes the two escapes text arrives in — `\'hh`
 * in the document's code page (1254 is assumed for anything not Unicode,
 * which covers both a Turkish and a Western file) and `\uN`.
 */
export function rtfToText(rtf: string): string {
  let s = rtf.replace(
    /\{\\(?:\*|fonttbl|colortbl|stylesheet|info|pict|listtable|listoverridetable|rsidtbl|generator|themedata|colorschememapping|latentstyles|datastore|xmlnstbl)[^{}]*(?:\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}[^{}]*)*\}/g,
    "",
  );
  s = s
    .replace(/\\u(-?\d+)\??/g, (_m, n: string) => {
      const code = Number(n) < 0 ? Number(n) + 65536 : Number(n);
      return String.fromCharCode(code);
    })
    .replace(/\\'([0-9a-fA-F]{2})/g, (_m, hex: string) =>
      decodeWindows1254(new Uint8Array([parseInt(hex, 16)])),
    )
    .replace(/\\(par|line|sect|page)\b ?/g, "\n")
    .replace(/\\tab\b ?/g, "\t")
    // Escaped braces and backslashes are text. Parked as private-use characters
    // while the real braces and control words are swept, then put back.
    .replace(/\\\{/g, "")
    .replace(/\\\}/g, "")
    .replace(/\\\\/g, "")
    .replace(/\\[a-zA-Z]+-?\d* ?/g, "")
    .replace(/[{}]/g, "")
    .replace(//g, "{")
    .replace(//g, "}")
    .replace(//g, "\\");
  return tidy(s);
}
