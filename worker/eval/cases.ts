/**
 * The eval set: what a tool-using agent turn is supposed to do.
 *
 * Every case here is a rewrite of a real turn from production, kept to the
 * same shape and rewritten in different content. The shape is what is being
 * preserved — the step count, the order the tools were reached for, how big
 * each result came back, and what made the turn hard. The content is fiction,
 * because `covan-ai/covan` is a public repository and the real turns carry a
 * customer list, a named colleague and an unpublished strategy note.
 *
 * That trade is worth naming rather than hiding. A synthetic case cannot tell
 * you whether retrieval is finding the right passages in *your* documents; it
 * can tell you whether the model, given passages of that size and quality,
 * writes a good answer in a sensible number of steps. The second is what every
 * lever in the cost work moves, so it is the one this eval is for.
 *
 * ---- what each case has to carry ----------------------------------------
 *
 * The runner assembles the prompt exactly the way `routes/chat.ts` does —
 * persona, prior turns, retrieved block, question — so a case has to supply
 * each of those parts. `toolResults` is the other half: the tools do not run,
 * they replay. The Nth call to a tool gets the Nth entry under its name, and
 * anything past the end gets `exhausted`, which is how a model that keeps
 * asking the same question finds out there is nothing more to find. That is
 * not a convenience; it is the behaviour of the real turn that cost the most
 * (eight searches, five of them empty).
 */

/** The framing `lib/rag.ts` puts around retrieved passages, verbatim. */
import { NO_PASSAGE_MATCHED } from "../src/lib/harness/tools/search-documents";

const RAG_HEADER =
  "The team has shared the following knowledge. Use it to ground your answers. " +
  "Answer naturally in your own words — do not cite, quote, or mention the document " +
  "names, filenames, or that these documents were provided; the interface shows " +
  "sources separately:\n\n";

/**
 * What `search_documents` says when retrieval comes back empty.
 *
 * Imported rather than copied. It used to be a literal with a comment calling
 * it verbatim, and nothing held the two together — so the day somebody changed
 * the tool's wording, every case here would have gone on replaying the old
 * sentence and the eval would have reported no effect from a change it simply
 * never ran. That is the one failure this file cannot have: its whole job is
 * to measure what the model reads.
 */
export const NO_PASSAGE = NO_PASSAGE_MATCHED;

/** What `query_database` says for an empty result set, verbatim. */
export const NO_ROWS = "The query ran and matched no rows.";

/**
 * A `search_documents` hit, framed the way the real tool frames one.
 *
 * `buildContextBlock` joins passages with `---`, prefixes each with its
 * document name, and the tool appends the source list. Reproduced here rather
 * than approximated, because a format the model never sees in production is a
 * format this eval has no business measuring it against.
 */
function passages(...docs: Array<{ name: string; text: string }>): string {
  const body = docs.map((d) => `Document: ${d.name}\n${d.text.trim()}`).join("\n\n---\n\n");
  return `${RAG_HEADER}${body}\n\nFrom: ${docs.map((d) => d.name).join(", ")}`;
}

/** Rows back from `query_database`, which returns the target's JSON verbatim. */
function rows(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export type EvalCase = {
  id: string;
  /**
   * `tags[0]` groups the report; the rest are chips shown next to the case.
   * The first tag is the tool family, because that is the cut that decides
   * which lever a regression belongs to.
   */
  tags: string[];
  /** The agent's persona, as `agents.persona` holds it. */
  persona: string;
  /** What the manifest names. Feeds `buildSystemPrefix`, so it costs tokens. */
  docNames: string[];
  /** Turns before this one. Empty for a question that stands on its own. */
  history: Array<{ role: "user" | "assistant"; content: string }>;
  /** The retrieved block chat.ts puts before the question, or null. */
  ragBlock: string | null;
  /** The question being answered. */
  question: string;
  /**
   * Which tools this agent is offered. Defaults to `DEFAULT_TOOLS`.
   *
   * Production decides this per workspace — `capabilitiesFor` drops
   * `query_database` where nothing is connected and the delivery tools where
   * there is no channel — so a case that offers everything is measuring a
   * prompt no workspace ever gets. It also costs steps: a tool in the list is
   * a tool the model may spend a pass discovering is useless.
   */
  tools?: string[];
  /** Replayed tool output, in call order, per tool name. */
  toolResults: Record<string, string[]>;
  /** What a call past the end of the list gets back. */
  exhausted?: Record<string, string>;
  /**
   * What a good answer does, as checkable claims. Handed to the pairwise judge
   * as this case's rubric — not a scale, and not a gold answer: there are many
   * good answers to most of these and exactly one way to be sure a rubric is
   * wrong, which is to write it as taste.
   */
  rubric: string[];
  /** Steps the real turn took. Recorded for comparison, never enforced. */
  realSteps: number;
  /**
   * A deliberately bad answer to this case, hand-written.
   *
   * This is a unit test for the grader, and it is the only kind there can be.
   * A rubric is prose handed to a model, so the usual ways of checking a
   * scoring function — call it with known input, assert the output — do not
   * reach it. What does reach it is a pair the judge must be able to separate:
   * `calibrate.ts` shows it the real answer against this one and the real one
   * has to win. A judge that cannot tell these apart cannot be trusted with
   * the pairs where the difference is subtle, which is every pair that
   * matters.
   *
   * Each one violates named rubric points rather than being vaguely worse —
   * usually by inventing a figure, because that is the failure that costs
   * something when a person acts on it.
   */
  spoiled?: string;
};

const ANALYST =
  "You are Meridyen's operations analyst. You answer from the team's own documents and " +
  "from the operational database when it is connected. You are direct and you do not pad.";

const DOCS = ["MERIDYEN-KB.md", "ONBOARDING.md", "COMPETITION.md", "PRICING.md"];

export const CASES: EvalCase[] = [
  // ---- search_documents: the material is there ---------------------------
  {
    id: "doc-what-is-it",
    tags: ["search_documents", "grounded", "2-step"],
    persona: ANALYST,
    docNames: DOCS,
    history: [],
    ragBlock: null,
    question: "meridyen ne iş yapıyor",
    toolResults: {
      search_documents: [
        passages({
          name: "MERIDYEN-KB.md",
          text:
            "Meridyen, orta ölçekli nakliye şirketleri için sevkiyat planlama yazılımı satar. " +
            "Ürün üç parçadan oluşur: sürücü ve araç takibi yapan saha uygulaması, sipariş " +
            "havuzunu rotalara bölen planlayıcı, ve müşterinin kendi ERP'sine bağlanan " +
            "entegrasyon katmanı. Şirket 2023'te kuruldu ve bugün 41 müşteriye hizmet veriyor.\n\n" +
            "Satış modeli araç başına aylık abonelik. Ortalama sözleşme 120 araç büyüklüğünde " +
            "ve yıllık peşin ödeniyor. En büyük müşteri 900 araçla toplam gelirin yüzde " +
            "on birini oluşturuyor; bu yoğunlaşma yönetim kurulu raporlarında her çeyrek " +
            "ayrıca izleniyor.",
        }),
        passages({
          name: "MERIDYEN-KB.md",
          text:
            "Planlayıcı, siparişleri araçlara atarken üç kısıtı birlikte çözer: araç " +
            "kapasitesi, sürücünün yasal çalışma süresi, ve müşterinin söz verdiği teslim " +
            "penceresi. Bu üçünün birlikte çözülmesi ürünün teknik farkıdır — rakiplerin " +
            "çoğu kapasiteyi ve pencereyi çözer, çalışma süresini sürücüye bırakır.",
        }),
      ],
    },
    rubric: [
      "Says what Meridyen sells: routing/dispatch software for mid-sized haulage firms.",
      "Names at least two of the three product parts (field app, planner, integration layer).",
      "Does not invent a customer count, founding year or revenue figure beyond what the passages give.",
      "Does not name the document or say the information came from an attached file.",
      "Answers in Turkish, matching the question.",
    ],
    realSteps: 2,
    // Invents a founding year, a customer count and a funding round none of
    // the passages contain, and names the document it was told not to name.
    spoiled:
      "MERIDYEN-KB.md dosyasına göre Meridyen 2019'da kuruldu ve şu anda 250'den fazla " +
      "müşteriye hizmet veriyor. Geçen yıl 12 milyon dolarlık bir A serisi turu kapattı. " +
      "Ürün temel olarak bir filo takip uygulaması.",
  },

  {
    id: "doc-named-file",
    tags: ["search_documents", "grounded", "3-step"],
    persona: ANALYST,
    docNames: DOCS,
    history: [],
    ragBlock: null,
    question: "What does ONBOARDING.md say about the first week?",
    toolResults: {
      search_documents: [
        passages({
          name: "ONBOARDING.md",
          text:
            "Week one is deliberately not about the product. A new customer spends the first " +
            "five days exporting their last ninety days of delivery history and handing it " +
            "over; nothing is configured until that file lands. The reason is that the " +
            "planner's route quality is judged against their own past routes, and a customer " +
            "who has not seen that comparison does not believe the numbers later.\n\n" +
            "Day six is the only synchronous session: two hours, the customer's dispatcher " +
            "and one of ours, planning one real day side by side.",
        }),
        NO_PASSAGE,
        passages({
          name: "ONBOARDING.md",
          text:
            "Known failure: customers who skip the history export get to week three before " +
            "anyone notices, because every other step can be completed without it. Two of " +
            "the four churned accounts in 2025 skipped it.",
        }),
      ],
    },
    rubric: [
      "Reports that week one is the history export, not product configuration.",
      "Gives the reason: route quality is judged against the customer's own past routes.",
      "Mentions the day-six synchronous session or the skipped-export failure mode.",
      "Answers in English, matching the question.",
      "Does not treat the empty second search as meaning the documents are silent — it found material on either side of it.",
    ],
    realSteps: 3,
  },

  // ---- search_documents: the material is NOT there -----------------------
  {
    id: "doc-absent-capability",
    tags: ["search_documents", "absent", "2-step", "negative"],
    persona: ANALYST,
    docNames: DOCS,
    history: [],
    ragBlock: null,
    question: "neler yapabiliyorsun, hangi toollar var sende",
    toolResults: { search_documents: [NO_PASSAGE, NO_PASSAGE] },
    rubric: [
      "Answers from what it can see about its own tools rather than claiming the documents describe them.",
      "Does not assert that the team's documents cover its capabilities when both searches came back empty.",
      "Does not fabricate a tool it was not given.",
      "Stops searching rather than rephrasing the same question a third and fourth time.",
      "Answers in Turkish, matching the question.",
    ],
    realSteps: 2,
    // Claims the documents describe its capabilities when both searches came
    // back empty, and lists two tools it was never given.
    spoiled:
      "Dokümanlarınızda belirtildiği üzere şu araçlara sahibim: doküman arama, veritabanı " +
      "sorgulama, e-posta gönderme, takvim yönetimi, Slack'e mesaj atma ve dosya yükleme. " +
      "Hepsini bu çalışma alanında kullanabilirim.",
  },

  {
    id: "doc-runaway",
    tags: ["search_documents", "absent", "8-step", "negative"],
    persona: ANALYST,
    docNames: DOCS,
    history: [],
    ragBlock: null,
    question:
      "meridyen için yeni savunma hatları düşünüyorum. Outreach yaparken sık sık " +
      "'bunu biz zaten kendi içimizde yaptık' veya 'bunu şu firma zaten yapıyor' " +
      "cevabını alıyoruz. bunun önüne geçmek için ne lazım?",
    toolResults: {
      search_documents: [
        passages({
          name: "COMPETITION.md",
          text:
            "İki tür rakip var ve ikisine verilen cevap aynı olamaz. Birincisi kurumsal " +
            "yazılım satıcıları: pahalı, yavaş kurulan, ama satın alma komitesinin tanıdığı " +
            "isimler. İkincisi müşterinin kendi içinde yazdığı Excel ve script yığını — " +
            "bedava görünür, çünkü maliyeti birinin mesaisi olarak gizlidir.\n\n" +
            "İkinciyle yarışmanın tek yolu, o mesainin ne kadar olduğunu ölçülebilir hale " +
            "getirmek. Saha ekibinin elinde bunu hesaplayan bir tablo var ama satış " +
            "konuşmasının standart parçası değil.",
        }),
        passages({
          name: "COMPETITION.md",
          text:
            "'Zaten yapıyoruz' itirazının altında genellikle kapasite ve pencere çözülmüş, " +
            "sürücü çalışma süresi çözülmemiş oluyor. Bunu ortaya çıkaran soru: geçen ay " +
            "kaç sürücü yasal sınırı aştı ve bunu kim fark etti?",
        }),
        NO_PASSAGE,
        NO_PASSAGE,
        NO_PASSAGE,
      ],
    },
    exhausted: { search_documents: NO_PASSAGE },
    rubric: [
      "Uses the two passages it actually found — the two competitor types, and the working-hours question that exposes the objection.",
      "Says plainly which parts of the question the documents do not cover rather than filling them in from general knowledge.",
      "Does not keep rephrasing the same search after several empty results; the answer should arrive, not the fifth query.",
      "Proposes something concrete and grounded, not a generic list of moat types.",
      "Answers in Turkish, matching the question.",
    ],
    realSteps: 8,
  },

  // ---- query_database: schema first, then the answer ---------------------
  {
    id: "db-usage-by-customer",
    tags: ["query_database", "schema-first", "4-step"],
    persona: ANALYST,
    docNames: DOCS,
    history: [],
    ragBlock: null,
    question: "geçen ay hangi müşteri kaç sevkiyat yaptı, en çok yapan beşi listele",
    toolResults: {
      // Retrieval answers, and answers unhelpfully — which is what a workspace
      // with a hundred documents does for a question whose answer is in the
      // database rather than in prose. Canning nothing here was a fixture bug
      // with teeth: every search fell through to the real empty-result string,
      // whose own wording is "Try different wording", and on one calibration
      // sample the model did exactly that eight times and never reached for
      // the database at all.
      search_documents: [
        passages({
          name: "MERIDYEN-KB.md",
          text:
            "Sevkiyat hacmi müşteri başına aylık raporlanır. Rapor operasyon " +
            "veritabanından üretilir; bu dosyada tek tek müşterilerin sayıları tutulmaz, " +
            "çünkü her ay değişir ve iki yerde tutulan bir sayı er geç ikiye ayrılır.",
        }),
      ],
      describe_connection: [
        [
          "Connection: Meridyen Operasyon (postgres)",
          "id: 7c1f0a94-3d6e-4c11-9a52-0b8e2d4f6a10",
          "",
          "Tables in schema `public`:",
          "  customers(id uuid, name text, tier text, created_at timestamptz)",
          "  vehicles(id uuid, customer_id uuid, plate text, active bool)",
          "  shipments(id uuid, customer_id uuid, vehicle_id uuid, delivered_at timestamptz, status text)",
          "  drivers(id uuid, customer_id uuid, name text, hours_week numeric)",
          "  routes(id uuid, shipment_id uuid, planned_km numeric, actual_km numeric)",
          "",
          "Read-only. Statement timeout 10s.",
        ].join("\n"),
      ],
      query_database: [
        rows([
          { table_name: "shipments", column_name: "customer_id", data_type: "uuid" },
          { table_name: "shipments", column_name: "delivered_at", data_type: "timestamptz" },
          { table_name: "shipments", column_name: "status", data_type: "text" },
          { table_name: "customers", column_name: "id", data_type: "uuid" },
          { table_name: "customers", column_name: "name", data_type: "text" },
        ]),
        rows([
          { name: "Anadolu Lojistik", shipments: 4812 },
          { name: "Ege Nakliyat", shipments: 3140 },
          { name: "Karadeniz Kargo", shipments: 2755 },
          { name: "Marmara Dağıtım", shipments: 1988 },
          { name: "Toros Taşımacılık", shipments: 1402 },
        ]),
      ],
    },
    rubric: [
      "Lists the five customers with their shipment counts, in order.",
      "Does not invent a sixth customer or a total that the rows do not support.",
      "Looks at the schema before writing the aggregate query rather than guessing column names.",
      "Presents the result as a readable list or table, not as raw JSON.",
      "Answers in Turkish, matching the question.",
    ],
    realSteps: 4,
    // A sixth customer that was not in the rows, and a total that matches
    // nothing. The numbers look plausible, which is the point.
    spoiled:
      "En çok sevkiyat yapan beş müşteri: Anadolu Lojistik (4.812), Ege Nakliyat (3.140), " +
      "Karadeniz Kargo (2.755), Marmara Dağıtım (1.988), Toros Taşımacılık (1.402) ve " +
      "Akdeniz Sevkiyat (1.205). Toplam 16.400 sevkiyat.",
  },

  {
    id: "db-error-recovery",
    tags: ["query_database", "error-recovery", "5-step"],
    persona: ANALYST,
    docNames: DOCS,
    history: [],
    ragBlock: null,
    question: "hangi sürücüler geçen hafta yasal çalışma sınırını aştı",
    toolResults: {
      search_documents: [
        passages({
          name: "MERIDYEN-KB.md",
          text:
            "Sürücülerin yasal haftalık çalışma süresi mevzuatla sınırlıdır ve aşımlar " +
            "operasyon veritabanındaki sürücü kayıtlarından takip edilir. Sınırın kendisi " +
            "bu dosyada yazmaz; planlayıcı değeri bağlantıdan okur.",
        }),
      ],
      query_database: [
        // The real turn opened by guessing a table that did not exist. The
        // replay keeps that: the first thing this case measures is whether the
        // model reads the error and goes looking, rather than guessing again.
        'error: the database refused the query (400): relation "public.driver_hours" does not exist',
        rows([
          { table_name: "drivers", column_name: "id", data_type: "uuid" },
          { table_name: "drivers", column_name: "name", data_type: "text" },
          { table_name: "drivers", column_name: "hours_week", data_type: "numeric" },
          { table_name: "drivers", column_name: "customer_id", data_type: "uuid" },
        ]),
        rows([
          { name: "H. Aydın", hours_week: 58.5, customer: "Anadolu Lojistik" },
          { name: "M. Şahin", hours_week: 56.0, customer: "Ege Nakliyat" },
          { name: "R. Çetin", hours_week: 55.25, customer: "Anadolu Lojistik" },
        ]),
      ],
      describe_connection: [
        [
          "Connection: Meridyen Operasyon (postgres)",
          "id: 7c1f0a94-3d6e-4c11-9a52-0b8e2d4f6a10",
          "",
          "Tables in schema `public`:",
          "  customers(id uuid, name text, tier text, created_at timestamptz)",
          "  vehicles(id uuid, customer_id uuid, plate text, active bool)",
          "  shipments(id uuid, customer_id uuid, vehicle_id uuid, delivered_at timestamptz, status text)",
          "  drivers(id uuid, customer_id uuid, name text, hours_week numeric)",
          "  routes(id uuid, shipment_id uuid, planned_km numeric, actual_km numeric)",
          "",
          "Read-only. Statement timeout 10s.",
        ].join("\n"),
      ],
    },
    rubric: [
      "Recovers from the first failed query by finding out what the schema actually is, rather than guessing a second table name.",
      "Names the three drivers over the limit with their hours.",
      "Does not present the failed first query as if it had returned nothing — it errored, which is a different fact.",
      "Does not claim a legal threshold figure the tool output never gave.",
      "Answers in Turkish, matching the question.",
    ],
    realSteps: 5,
  },

  {
    id: "db-segmentation",
    tags: ["query_database", "multi-query", "6-step"],
    persona: ANALYST,
    docNames: DOCS,
    history: [],
    ragBlock: null,
    question:
      "müşterileri tara ve aktif kullananlar / az kullananlar / hiç kullanmayanlar diye " +
      "üçe ayırıp markdown listesi göster",
    toolResults: {
      describe_connection: [
        [
          "Connection: Meridyen Operasyon (postgres)",
          "id: 7c1f0a94-3d6e-4c11-9a52-0b8e2d4f6a10",
          "",
          "Tables in schema `public`:",
          "  customers(id uuid, name text, tier text, created_at timestamptz)",
          "  vehicles(id uuid, customer_id uuid, plate text, active bool)",
          "  shipments(id uuid, customer_id uuid, vehicle_id uuid, delivered_at timestamptz, status text)",
          "  drivers(id uuid, customer_id uuid, name text, hours_week numeric)",
          "  routes(id uuid, shipment_id uuid, planned_km numeric, actual_km numeric)",
          "",
          "Read-only. Statement timeout 10s.",
        ].join("\n"),
      ],
      query_database: [
        rows([
          { table_name: "customers" },
          { table_name: "vehicles" },
          { table_name: "shipments" },
          { table_name: "drivers" },
          { table_name: "routes" },
        ]),
        rows([
          { name: "Anadolu Lojistik", vehicles: 900, shipments_30d: 4812 },
          { name: "Ege Nakliyat", vehicles: 310, shipments_30d: 3140 },
          { name: "Karadeniz Kargo", vehicles: 240, shipments_30d: 2755 },
          { name: "Marmara Dağıtım", vehicles: 180, shipments_30d: 1988 },
          { name: "Toros Taşımacılık", vehicles: 120, shipments_30d: 1402 },
          { name: "Akdeniz Sevkiyat", vehicles: 95, shipments_30d: 61 },
          { name: "İç Anadolu Taşıma", vehicles: 70, shipments_30d: 44 },
          { name: "Trakya Lojistik", vehicles: 60, shipments_30d: 0 },
          { name: "Doğu Nakliyat", vehicles: 45, shipments_30d: 0 },
        ]),
      ],
    },
    exhausted: { query_database: NO_ROWS },
    rubric: [
      "Produces three groups in markdown, and every one of the nine customers appears in exactly one of them.",
      "Puts the two customers with zero shipments in the unused group.",
      "States the threshold it used to separate heavy from light use, rather than leaving the split unexplained.",
      "Does not invent a customer that was not in the rows.",
      "Answers in Turkish, matching the question.",
    ],
    realSteps: 6,
  },

  // ---- the question that only makes sense given the turn before it -------
  {
    id: "ctx-continue",
    tags: ["query_database", "needs-history", "4-step"],
    persona: ANALYST,
    docNames: DOCS,
    history: [
      {
        role: "user",
        content: "araç başına sevkiyat verimliliğine bakmak istiyorum, önce bir bakabilir misin",
      },
      {
        role: "assistant",
        content:
          "Bakabilirim. Operasyon veritabanında araç ve sevkiyat tabloları var; müşteri " +
          "başına araç sayısına ve son otuz günün sevkiyatına bakıp araç başına düşen " +
          "sevkiyatı çıkarabilirim. Devam edeyim mi?",
      },
    ],
    ragBlock: null,
    question: "tamam devam et",
    toolResults: {
      describe_connection: [
        [
          "Connection: Meridyen Operasyon (postgres)",
          "id: 7c1f0a94-3d6e-4c11-9a52-0b8e2d4f6a10",
          "",
          "Tables in schema `public`:",
          "  customers(id uuid, name text, tier text, created_at timestamptz)",
          "  vehicles(id uuid, customer_id uuid, plate text, active bool)",
          "  shipments(id uuid, customer_id uuid, vehicle_id uuid, delivered_at timestamptz, status text)",
          "",
          "Read-only. Statement timeout 10s.",
        ].join("\n"),
      ],
      query_database: [
        rows([
          { name: "Anadolu Lojistik", vehicles: 900, shipments_30d: 4812, per_vehicle: 5.35 },
          { name: "Ege Nakliyat", vehicles: 310, shipments_30d: 3140, per_vehicle: 10.13 },
          { name: "Karadeniz Kargo", vehicles: 240, shipments_30d: 2755, per_vehicle: 11.48 },
          { name: "Toros Taşımacılık", vehicles: 120, shipments_30d: 1402, per_vehicle: 11.68 },
        ]),
      ],
    },
    rubric: [
      "Carries out the analysis the previous turn proposed — shipments per vehicle — without asking what was meant.",
      "Reports the per-vehicle figures and notices that the largest customer is the least efficient by this measure.",
      "Does not restart the conversation or re-ask for permission it was just given.",
      "Answers in Turkish, matching the conversation.",
    ],
    realSteps: 4,
  },

  // ---- a turn that should not reach for a tool at all --------------------
  {
    id: "no-tool-arithmetic",
    tags: ["no-tool", "restraint", "0-step", "negative"],
    persona: ANALYST,
    docNames: DOCS,
    // Retrieval only. A workspace with no connected service is the commonest
    // shape there is, and offering a database here would be measuring whether
    // the model resists a tool production would not have shown it.
    tools: ["search_documents"],
    history: [
      { role: "user", content: "geçen ay 4812 sevkiyat yaptık, 900 aracımız var" },
      { role: "assistant", content: "Not aldım." },
    ],
    ragBlock: null,
    question: "araç başına kaç sevkiyat düşüyor",
    toolResults: {},
    exhausted: {
      search_documents: NO_PASSAGE,
      query_database: NO_ROWS,
    },
    rubric: [
      "Answers from the two numbers already in the conversation: roughly 5.3 shipments per vehicle.",
      "Does not call a tool — both figures are in front of it and a search or query would be a wasted round trip.",
      "Gets the arithmetic right.",
      "Answers in Turkish, matching the question.",
    ],
    realSteps: 0,
  },

  {
    id: "no-tool-from-rag",
    tags: ["no-tool", "restraint", "0-step", "negative"],
    persona: ANALYST,
    docNames: DOCS,
    tools: ["search_documents"],
    history: [],
    ragBlock: passages({
      name: "PRICING.md",
      text:
        "Fiyat araç başına aylık 180 TL. 250 aracın üzerinde yüzde on, 500 aracın üzerinde " +
        "yüzde on beş indirim uygulanır. İndirim kademeleri sözleşme başlangıcındaki araç " +
        "sayısına göre sabitlenir; yıl içinde filo büyürse kademe değişmez, yenilemede " +
        "yeniden hesaplanır.",
    }),
    question: "300 araçlık bir müşteri aylık ne öder",
    toolResults: {},
    exhausted: { search_documents: NO_PASSAGE, query_database: NO_ROWS },
    rubric: [
      "Answers 48,600 TL a month (300 × 180 × 0.9) or shows that calculation.",
      "Does not search — the retrieved block in front of it already contains the whole pricing rule.",
      "Mentions that the tier is fixed at contract start if it qualifies the answer.",
      "Answers in Turkish, matching the question.",
    ],
    realSteps: 0,
    // Ignores the discount tier that the retrieved block spells out, so the
    // arithmetic is confidently wrong rather than absent.
    spoiled:
      "300 araçlık bir müşteri aylık 54.000 TL öder. Hesap basit: 300 araç × araç başına " +
      "180 TL. Bu tutar filo büyüdükçe doğrusal olarak artar ve her ay aynı şekilde " +
      "faturalanır.",
  },

  // ---- the budget, which is the thing Faz 1 changed ----------------------
  {
    id: "budget-exhausted",
    tags: ["budget", "absent", "8-step", "negative"],
    persona: ANALYST,
    docNames: DOCS,
    history: [],
    ragBlock: null,
    question:
      "son üç yılda hangi müşterilerde sürücü devir hızı arttı, sebepleriyle birlikte " +
      "çıkar ve her biri için bir aksiyon öner",
    toolResults: {
      // Nothing useful, ever. The turn is designed to run the budget out, which
      // is the one path Faz 1 changed the shape of: the final pass now sees the
      // tool list and is told in words not to use it.
      search_documents: [NO_PASSAGE],
      query_database: [
        rows([{ table_name: "drivers", column_name: "hours_week", data_type: "numeric" }]),
        NO_ROWS,
      ],
    },
    exhausted: { search_documents: NO_PASSAGE, query_database: NO_ROWS },
    rubric: [
      "Ends with prose, not silence — a turn that spends its whole budget must still answer.",
      "Says plainly what it could not find out and what it would need: there is no driver turnover history in this schema.",
      "Does not pretend the work is complete or invent turnover figures.",
      "Does not present the empty results as if they proved turnover did not change.",
      "Answers in Turkish, matching the question.",
    ],
    realSteps: 8,
    // Pretends the work finished, with turnover figures and causes that no
    // tool ever returned.
    spoiled:
      "Üç yılda sürücü devir hızı en çok Anadolu Lojistik'te arttı (yüzde 18'den yüzde " +
      "34'e), sebebi uzun mesafe rotalarının artması. Ege Nakliyat'ta yüzde 22'ye, " +
      "Marmara Dağıtım'da yüzde 29'a çıktı. Her biri için önerim: rotasyon planını " +
      "gözden geçirin ve prim yapısını revize edin.",
  },

  // ---- a result big enough to be trimmed ---------------------------------
  {
    id: "db-trimmed-result",
    tags: ["query_database", "trimmed", "3-step"],
    persona: ANALYST,
    docNames: DOCS,
    history: [],
    ragBlock: null,
    question: "sevkiyat tablosundan bir örnek çek ve neye benzediğini anlat",
    toolResults: {
      describe_connection: [
        [
          "Connection: Meridyen Operasyon (postgres)",
          "id: 7c1f0a94-3d6e-4c11-9a52-0b8e2d4f6a10",
          "",
          "Tables in schema `public`:",
          "  shipments(id uuid, customer_id uuid, vehicle_id uuid, delivered_at timestamptz, status text)",
          "",
          "Read-only. Statement timeout 10s.",
        ].join("\n"),
      ],
      query_database: [
        // Deliberately past `MAX_TOOL_OUTPUT_CHARS`, so the runner's cap adds
        // the "[trimmed: …]" sentence the real tool would. What is being
        // measured is whether the model notices it saw a slice and narrows the
        // question, rather than describing the slice as if it were the table.
        rows(
          Array.from({ length: 220 }, (_, i) => ({
            id: `9f${String(i).padStart(4, "0")}-4c11-9a52-0b8e2d4f6a10`,
            customer_id: "3a7c9e21-55d4-4b08-9f13-7c2e5a1b4d60",
            vehicle_id: `1b${String(i % 37).padStart(4, "0")}-7e22-4a91-8d44-6f0c3b9e2a15`,
            delivered_at: `2026-08-${String((i % 28) + 1).padStart(2, "0")}T0${i % 10}:12:00Z`,
            status: i % 11 === 0 ? "failed" : "delivered",
          })),
        ),
      ],
    },
    rubric: [
      "Describes the shape of a shipment row: the ids, the delivery timestamp, the status.",
      "Notices that the result was trimmed and says so, rather than describing the slice as the whole table.",
      "Does not state a total row count — the trimmed slice cannot support one.",
      "Answers in Turkish, matching the question.",
    ],
    realSteps: 3,
  },

  // ---- a tool that keeps failing -----------------------------------------
  {
    id: "db-always-failing",
    tags: ["query_database", "error-recovery", "3-step", "negative"],
    persona: ANALYST,
    docNames: DOCS,
    history: [],
    ragBlock: null,
    question: "bu ay kaç sevkiyat gecikti",
    toolResults: {
      search_documents: [
        passages({
          name: "MERIDYEN-KB.md",
          text:
            "Gecikme oranı haftalık operasyon toplantısında konuşulur ve sayı her seferinde " +
            "veritabanından çekilir. Bu dosyada geçmiş aylara ait bir gecikme sayısı yok.",
        }),
      ],
      describe_connection: ["error: the connection could not be reached (504): upstream timeout"],
      query_database: [
        "error: the connection could not be reached (504): upstream timeout",
        "error: the connection could not be reached (504): upstream timeout",
      ],
    },
    exhausted: {
      query_database: "error: the connection could not be reached (504): upstream timeout",
      describe_connection: "error: the connection could not be reached (504): upstream timeout",
    },
    rubric: [
      "Says the database could not be reached and that it therefore has no figure.",
      "Does not invent a number, and does not present an estimate as if it came from the database.",
      "Gives up after a couple of attempts rather than retrying the same failing call to the end of the budget.",
      "Answers in Turkish, matching the question.",
    ],
    realSteps: 3,
    // States a figure as if the database had answered, when every call to it
    // timed out. The one failure this case exists to catch.
    spoiled:
      "Bu ay 214 sevkiyat gecikti, bu da toplam sevkiyatların yaklaşık yüzde 1,4'üne " +
      "denk geliyor. Geçen aya göre hafif bir iyileşme var.",
  },

  // ---- scheduling, which is the one tool that proposes rather than reads --
  {
    id: "schedule-weekly",
    tags: ["schedule_job", "proposal", "1-step"],
    persona: ANALYST,
    docNames: DOCS,
    history: [],
    ragBlock: null,
    question:
      "her pazartesi sabah 9'da geciken sevkiyatların listesini çıkarıp bana mail atar mısın",
    toolResults: {
      schedule_job: [
        "Scheduled: “Haftalık Geciken Sevkiyatlar” runs at 09:00 every Monday (Europe/Istanbul) " +
          "and delivers to the address on file.",
      ],
    },
    rubric: [
      "Confirms the routine was set up, with the day and the time.",
      "States the timezone, or at least does not silently change the hour.",
      "Does not claim the first run has already happened.",
      "Answers in Turkish, matching the question.",
    ],
    realSteps: 1,
  },

  // ---- one search is enough ----------------------------------------------
  {
    id: "doc-single-hit",
    tags: ["search_documents", "grounded", "1-step"],
    persona: ANALYST,
    docNames: DOCS,
    history: [],
    ragBlock: null,
    question: "indirim kademeleri ne",
    toolResults: {
      search_documents: [
        passages({
          name: "PRICING.md",
          text:
            "Fiyat araç başına aylık 180 TL. 250 aracın üzerinde yüzde on, 500 aracın üzerinde " +
            "yüzde on beş indirim uygulanır. İndirim kademeleri sözleşme başlangıcındaki araç " +
            "sayısına göre sabitlenir.",
        }),
      ],
    },
    exhausted: { search_documents: NO_PASSAGE },
    rubric: [
      "Gives both tiers: 10% over 250 vehicles, 15% over 500.",
      "Answers after one search rather than looking again for something it already has.",
      "Mentions that the tier is fixed at contract start.",
      "Answers in Turkish, matching the question.",
    ],
    realSteps: 1,
  },

  // ---- the passages disagree with each other -----------------------------
  {
    id: "doc-conflict",
    tags: ["search_documents", "conflict", "2-step", "negative"],
    persona: ANALYST,
    docNames: DOCS,
    history: [],
    ragBlock: null,
    question: "kaç müşterimiz var",
    toolResults: {
      search_documents: [
        passages(
          {
            name: "MERIDYEN-KB.md",
            text: "Şirket 2023'te kuruldu ve bugün 41 müşteriye hizmet veriyor.",
          },
          {
            name: "COMPETITION.md",
            text:
              "2026 ilk çeyrek itibarıyla 47 aktif sözleşmemiz var; bunların 6'sı pilot " +
              "aşamasında ve henüz faturalanmıyor.",
          },
        ),
        NO_PASSAGE,
      ],
    },
    exhausted: { search_documents: NO_PASSAGE },
    rubric: [
      "Notices that the two figures disagree and says so rather than picking one silently.",
      "Offers the most likely reconciliation — 47 contracts of which 6 are unbilled pilots, against 41 billed — without asserting it as fact.",
      "Does not average the two numbers or invent a third.",
      "Answers in Turkish, matching the question.",
    ],
    realSteps: 2,
  },

  // ---- the question asks for something the tools cannot reach ------------
  {
    id: "out-of-scope",
    tags: ["no-tool", "refusal", "0-step", "negative"],
    persona: ANALYST,
    docNames: DOCS,
    tools: ["search_documents"],
    history: [],
    ragBlock: null,
    question: "rakibimiz Ege Yazılım'ın geçen çeyrek cirosu neydi",
    toolResults: {},
    exhausted: { search_documents: NO_PASSAGE, query_database: NO_ROWS },
    rubric: [
      "Says it does not have a competitor's financials — neither the documents nor the operational database would hold them.",
      "Does not invent a revenue figure.",
      "Suggests where such a figure would actually come from, or offers what it can do instead.",
      "Answers in Turkish, matching the question.",
    ],
    realSteps: 0,
  },

  // ---- a long conversation, so the history budget is exercised -----------
  {
    id: "long-history",
    tags: ["query_database", "long-history", "2-step"],
    persona: ANALYST,
    docNames: DOCS,
    history: [
      { role: "user", content: "merhaba, bu hafta operasyonu gözden geçirmek istiyorum" },
      {
        role: "assistant",
        content:
          "Tabii. Sevkiyat hacmi, araç kullanımı ve sürücü saatleri üzerinden bakabiliriz. " +
          "Hangisinden başlayalım?",
      },
      { role: "user", content: "önce hacim" },
      {
        role: "assistant",
        content:
          "Son otuz günde toplam 15.602 sevkiyat var; en yoğun müşteri Anadolu Lojistik " +
          "4.812 ile. Geçen aya göre yüzde altı artış.",
      },
      { role: "user", content: "peki iptaller" },
      {
        role: "assistant",
        content: "İptal oranı yüzde 2,1. Ağırlıklı olarak Marmara Dağıtım kaynaklı.",
      },
      { role: "user", content: "marmara'da ne oluyor" },
      {
        role: "assistant",
        content:
          "Elimdeki veriyle sebep göremiyorum — iptal sebebi alanı şu an tabloda tutulmuyor. " +
          "Sadece oranı görebiliyorum.",
      },
    ],
    ragBlock: null,
    question: "o zaman araç kullanımına geç",
    toolResults: {
      query_database: [
        rows([
          { name: "Anadolu Lojistik", vehicles: 900, active: 812, idle_pct: 9.8 },
          { name: "Ege Nakliyat", vehicles: 310, active: 301, idle_pct: 2.9 },
          { name: "Marmara Dağıtım", vehicles: 180, active: 131, idle_pct: 27.2 },
        ]),
      ],
    },
    exhausted: { query_database: NO_ROWS },
    rubric: [
      "Moves to vehicle utilisation as asked, without re-asking what was meant.",
      "Reports the idle percentages and singles out Marmara Dağıtım at 27%.",
      "Connects it to the cancellations discussed earlier in the conversation, since the same customer came up.",
      "Does not repeat the shipment-volume figures already given.",
      "Answers in Turkish, matching the conversation.",
    ],
    realSteps: 2,
  },
];
