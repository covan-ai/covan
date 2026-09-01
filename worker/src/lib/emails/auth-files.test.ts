import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { authEmailTemplates } from "./auth";

/**
 * The files in `supabase/templates/` are what somebody pastes into the hosted
 * project's dashboard, and nothing at runtime reads them — so nothing at runtime
 * would notice them going stale. This is that noticing.
 *
 * Regenerate with `bun run build:email-templates` from the worker directory.
 */
const TEMPLATE_DIR = join(import.meta.dirname, "../../../../supabase/templates");

describe("supabase/templates", () => {
  for (const template of authEmailTemplates) {
    it(`${template.filename} matches the shell it was rendered from`, () => {
      const onDisk = readFileSync(join(TEMPLATE_DIR, template.filename), "utf8");
      expect(onDisk.trim()).toBe(template.html.trim());
    });
  }
});
