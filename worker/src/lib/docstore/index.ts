import type { Bindings } from "../../types";
import type { DocStore } from "./types";
import { r2DocStore } from "./r2";
import { fsDocStore } from "./fs";

export type { DocStore, StoredObject } from "./types";

/**
 * Pick a store from the environment. The R2 binding only exists on Cloudflare,
 * so its presence is the runtime discriminator — no explicit mode flag to keep
 * in sync.
 */
export function getDocStore(env: Pick<Bindings, "DOCS" | "DOCS_DIR">): DocStore {
  if (env.DOCS) return r2DocStore(env.DOCS);

  const root = env.DOCS_DIR;
  if (!root) {
    throw new Error(
      "No document storage configured: bind DOCS (Cloudflare R2) or set DOCS_DIR (filesystem).",
    );
  }
  return fsDocStore(root);
}
