/**
 * Enough CSV to draw a table with.
 *
 * Not a CSV implementation, for the same reason `markdown.tsx` is not a Markdown
 * one: this renders a file somebody uploaded so they can see what is in it, and
 * the cost of being wrong is a cell drawn oddly rather than data misread — the
 * indexed text comes from the file itself, never from this. So it handles the
 * two things that actually break a naive split and stops there: a quoted field
 * containing the delimiter or a newline, and `""` as an escaped quote.
 *
 * Deliberately absent: delimiter sniffing (a semicolon file renders as one
 * column, which is visibly one column rather than quietly wrong), encodings
 * (the blob is decoded as UTF-8 before it arrives here, the same way the
 * extractor does it), and any notion of a header — the caller decides whether
 * the first row is one, because a file with no header must not lose its first
 * row to being drawn as one.
 */
export function parseCsv(text: string, maxRows = Infinity): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    // A trailing newline ends the last row rather than starting an empty one.
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === "") {
      quoted = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\n") {
      endRow();
      if (rows.length >= maxRows) return rows;
    } else if (ch !== "\r") {
      field += ch;
    }
  }

  if (field !== "" || row.length > 0) endRow();
  return rows;
}
