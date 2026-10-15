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

  /**
   * Bytes `[offset, offset + length)` of an object, and its total size — null
   * when the key does not exist. A range past the end is cut at the end.
   *
   * What lets a 100 MB upload be read without holding 100 MB: a `.docx` keeps
   * its text in one small entry and its index at the very end, so the reader
   * asks for those two places and nothing else (`lib/formats/read/zip.ts`).
   */
  getRange(key: string, offset: number, length: number): Promise<RangeRead | null>;

  /**
   * An object written in parts, each its own request.
   *
   * The upload's way past the request body limit: a file arrives as 8 MiB
   * parts, every one of them small enough for any route, and becomes one
   * object at `complete`. Every part but the last must be the same size — R2
   * requires it, and the filesystem store does not care.
   */
  createMultipart(key: string, opts: { contentType: string }): Promise<string>;
  uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: ArrayBuffer,
  ): Promise<UploadedPart>;
  completeMultipart(key: string, uploadId: string, parts: UploadedPart[]): Promise<void>;
  /** Succeeds whether or not the upload still exists. */
  abortMultipart(key: string, uploadId: string): Promise<void>;
}

export type RangeRead = { bytes: Uint8Array; size: number };

/** What a part's upload returns, and what `completeMultipart` is handed back. */
export type UploadedPart = { partNumber: number; etag: string };
