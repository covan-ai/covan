import { i18n } from "@/i18n";

/**
 * Runs a test body with the interface in Turkish, and puts it back.
 *
 * Every test runs in English by default (`test-setup.ts`), which is why the
 * existing assertions on English copy keep passing. A test that wants to
 * see the translation wraps its render and its assertions in this.
 */
export async function inTurkish<T>(run: () => T | Promise<T>): Promise<T> {
  await i18n.changeLanguage("tr");
  try {
    return await run();
  } finally {
    await i18n.changeLanguage("en");
  }
}
