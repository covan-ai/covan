/**
 * One stored object. Mirrors the subset of R2's object that routes actually
 * use: a streamable body, the content type recorded at upload, and a whole-file
 * read for text extraction.
 */
export type StoredObject = {
  body: ReadableStream<Uint8Array>;
  contentType?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
};

/**
 * Blob storage for uploaded documents.
 *
 * Two implementations exist: R2 on Cloudflare, and the filesystem for
 * self-hosted Docker. Routes must depend on this interface and never touch
 * `env.DOCS` directly, or the Node build breaks silently.
 */
export interface DocStore {
  /** Null when the key does not exist — never throws for a missing key. */
  get(key: string): Promise<StoredObject | null>;
  put(key: string, body: ArrayBuffer, opts: { contentType: string }): Promise<void>;
  /** Succeeds whether or not the key existed. */
  delete(key: string): Promise<void>;
}
