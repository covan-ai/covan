import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";

/**
 * How much of a request body the API will read, and the answer when there is
 * more.
 *
 * `Content-Length` is a claim a client may leave out: a chunked upload has
 * none, and a route that refuses on the header alone then reads the whole
 * stream into memory to find out how big it was. On Workers the platform
 * stops that at its own limit; the Node entry has none, and three 200 MB
 * streams were enough to push it past 1.8 GB. `hono/body-limit` counts the
 * bytes as they arrive and answers 413 the moment the limit is passed, with or
 * without the header.
 *
 * One ceiling for every request (`index.ts`), and a tighter one per route that
 * takes a file — the routes below know how big their file may be, and the
 * ceiling only knows how big the largest of them is.
 */

/** The largest body any route takes: an upload's file and the text extracted from it. */
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

/** Room for multipart's boundaries and headers around a file of a known size. */
const MULTIPART_OVERHEAD = 64 * 1024;

export function tooLarge(c: Context) {
  return c.json({ error: "payload too large" }, 413);
}

/**
 * A limit for one route that takes a file of at most `fileBytes`, plus
 * whatever else the form carries (`extraBytes`).
 */
export function uploadLimit(fileBytes: number, message: string, extraBytes = 0) {
  return bodyLimit({
    maxSize: fileBytes + extraBytes + MULTIPART_OVERHEAD,
    onError: (c) => c.json({ error: message }, 413),
  });
}
