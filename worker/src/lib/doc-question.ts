/**
 * Is this turn asking about the agent's documents?
 *
 * The question exists because of the fallback in `routes/chat.ts`. Semantic
 * retrieval misses a whole class of legitimate question — "summarize the file",
 * "what's in the doc" — because they are *about* a document rather than about
 * anything written in one, so they embed near no single passage and every chunk
 * falls under the similarity floor. The fallback answers that by grounding on
 * the documents' stored text directly.
 *
 * Firing it on *every* miss is what went wrong. "thanks", "merhaba", "rewrite
 * that in English" all miss too, and each one was pulling the agent's files
 * into the prompt, paying for them, and — because the fallback also recorded
 * them — hanging a row of source chips under an answer that came from nothing
 * but the persona. So the fallback now needs a reason.
 *
 * The trade this makes: a content question that genuinely misses the floor gets
 * no grounding rather than the newest few thousand characters of whatever
 * happens to be attached. That is the better failure. The dumped text was not
 * selected for relevance to the question — it was selected for being recent —
 * so it answered the question only by luck, and `RAG_MIN_SIMILARITY` is the
 * dial that exists for a floor set too high.
 *
 * Turkish and English both, because the product is used in both, and a
 * heuristic that only understood one would silently switch the feature off for
 * half its users.
 */

/**
 * Stems, matched as substrings so suffixes come free: "dosyada", "dosyanın"
 * and "dosyayı" all follow from "dosya", and "documents" from "document".
 * Deliberately narrow — a word that shows up in ordinary conversation ("rapor",
 * "note", "text") would re-open the behaviour this exists to close.
 */
const DOCUMENT_WORDS = [
  // English
  "file",
  "document",
  "the doc",
  "docs",
  "pdf",
  "upload",
  "attach",
  "summar", // summary, summarize, summarise
  "transcript",
  "spreadsheet",
  "csv",
  "knowledge base",
  "what you know",
  "what does it say",
  "what's in it",
  "whats in it",
  // The starter cards an empty conversation offers (src/lib/chat-starters.ts).
  // They are written to produce a first answer with a citation on it, so the
  // ones that do not happen to contain the word "document" have to be
  // recognised here or the whole point of them is lost.
  "should i know",
  // Turkish
  "dosya",
  "belge",
  "doküman",
  "dokuman",
  "özet",
  "ozet",
  "yükledi", // yükledim, yüklediğim
  "yukledi",
  "yüklediğ",
  "ne diyor",
  "ne yazıyor",
  "ne yaziyor",
  "içinde ne",
  "icinde ne",
  "neler var",
  "bilmem gereken",
  "ne bilmeliyim",
];

/**
 * A filename is only a signal when it is distinctive. Two- and three-character
 * stems ("ai", "q3", "cv") appear inside ordinary words often enough that
 * matching them would fire on almost every sentence.
 */
const MIN_NAME_STEM = 4;

/**
 * Lowercase, with Turkish's four I's collapsed onto one.
 *
 * JavaScript lowercases by Unicode's default rules, not Turkish's: "İ" becomes
 * "i" plus a combining dot (U+0307), and "I" becomes "i" where Turkish would
 * make it "ı". So "İŞE ALIM" lowercases to "i̇şe alim" and stops matching a file
 * called "işe alım.md" — over a letter, in the language half the users type in.
 * Folding i/ı/İ/I together costs nothing here (this is a keyword match, not a
 * display name) and makes all four spellings the same string.
 *
 * Needles are folded with the same function, so both sides agree.
 */
function fold(value: string): string {
  return value.toLowerCase().replace(/̇/g, "").replace(/ı/g, "i");
}

const DOCUMENT_NEEDLES = DOCUMENT_WORDS.map(fold);

/** "Q3 Handbook.pdf" -> ["q3 handbook.pdf", "q3 handbook"] */
function nameNeedles(name: string): string[] {
  const full = fold(name).trim();
  if (!full) return [];
  const stem = full.replace(/\.[a-z0-9]{1,8}$/, "");
  return stem && stem !== full ? [full, stem] : [full];
}

/** Whether this message names this particular document. */
export function namesDocument(message: string, docName: string): boolean {
  const text = fold(message);
  if (!text.trim()) return false;
  return nameNeedles(docName).some(
    (needle) => needle.length >= MIN_NAME_STEM && text.includes(needle),
  );
}

export function refersToDocuments(message: string, docNames: readonly string[]): boolean {
  const text = fold(message);
  if (!text.trim()) return false;

  if (DOCUMENT_NEEDLES.some((word) => text.includes(word))) return true;

  // Naming a file is the strongest signal there is, and the one the starter
  // prompts on an empty conversation lean on ("What does handbook.md say?").
  return docNames.some((name) => namesDocument(message, name));
}
