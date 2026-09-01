/**
 * Write `supabase/templates/*.html` from `src/lib/emails/auth.ts`.
 *
 * Run from the worker directory: `bun run build:email-templates`.
 *
 * The files exist to be pasted into the hosted project's dashboard
 * (Authentication → Emails), which is the only way a template reaches GoTrue on
 * a hosted Supabase project — `supabase/config.toml` configures a local stack
 * and cannot push anything. `auth-files.test.ts` fails if what is checked in
 * stops matching what this would write.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { authEmailTemplates } from "../src/lib/emails/auth";

const dir = join(import.meta.dirname, "../../supabase/templates");
mkdirSync(dir, { recursive: true });

for (const template of authEmailTemplates) {
  writeFileSync(join(dir, template.filename), `${template.html}\n`, "utf8");
  console.log(`wrote supabase/templates/${template.filename}  (subject: ${template.subject})`);
}
