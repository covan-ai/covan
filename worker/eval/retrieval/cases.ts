import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The retrieval benchmark's questions, and the corpus they are asked of.
 *
 * Everything in `corpus/` is invented: a startup of a few dozen people that
 * does not exist, its handbook, contracts, notes and price list. `AGENTS.md`
 * keeps real documents out of this repository, so this can say whether the
 * search finds the right passage in documents *shaped like* a team's — not in
 * any particular team's.
 *
 * A case is correct when a retrieved passage contains one of its `expect`
 * markers. Markers are phrases from the answering passage rather than chunk
 * ids, so the cases survive a change to how documents are chunked — which is
 * one of the things the benchmark exists to compare.
 */

export type Category =
  | "exact-term"
  | "paraphrase"
  | "morphology"
  | "cross-language"
  | "table"
  | "follow-up"
  | "versions"
  | "negative";

export type RetrievalCase = {
  /** Unique, kebab-case. */
  id: string;
  category: Category;
  /** The language the question is asked in. */
  lang: "tr" | "en";
  question: string;
  /** Prior turns, oldest first, not including `question`. */
  history?: { role: "user" | "assistant"; content: string }[];
  /** A retrieved passage containing any one of these counts as correct. [] for "negative". */
  expect: string[];
  /** For "negative" cases: the thing asked about, which appears nowhere in the corpus. */
  absent?: string;
};

const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), "corpus");

/**
 * Every corpus document, sorted by name. The order is the order they are
 * inserted in, which is what makes the newer of two versions the newer row.
 */
export function loadCorpus(): { name: string; text: string }[] {
  return readdirSync(CORPUS_DIR)
    .filter((name) => !name.startsWith("."))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(CORPUS_DIR, name), "utf8") }));
}

export const CASES: RetrievalCase[] = [
  // exact-term
  {
    id: "exact-term-clause-payment-due",
    category: "exact-term",
    lang: "tr",
    question: "Acme sözleşmesinin madde 4.2 hükmüne göre fatura kaç gün içinde ödenir?",
    expect: ["Fatura, vade tarihinden itibaren 30 gün içinde ödenir"],
  },
  {
    id: "exact-term-req-19",
    category: "exact-term",
    lang: "en",
    question: "What does REQ-19 say about how many solver runs a workspace may start?",
    expect: ["Solver runs are limited to 40 per workspace per day"],
  },
  {
    id: "exact-term-sku-support",
    category: "exact-term",
    lang: "en",
    question: "Which service does the Acme contract tie to SKU PRV-SUP-0066?",
    expect: ["7/24 destek, PRV-SUP-0066 kodlu"],
  },
  {
    id: "exact-term-error-rt-503",
    category: "exact-term",
    lang: "tr",
    question: "Rotalama çözücüsünde RT-503 hata kodu ne anlama geliyor?",
    expect: ["RT-503 Solver exceeded memory limit of 1.5 GB"],
  },
  {
    id: "exact-term-clause-12-3-cloudhost",
    category: "exact-term",
    lang: "en",
    question:
      "Under clause 12.3 of the CloudHost agreement, when may we terminate without early-termination fees?",
    expect: ["if availability of the managed database cluster falls below 99.0% in any two months"],
  },
  {
    id: "exact-term-schedule-c-subprocessors",
    category: "exact-term",
    lang: "tr",
    question:
      "CloudHost sözleşmesindeki Schedule C alt işleyici olarak hangi Frankfurt veri merkezini sayıyor?",
    expect: ["Rheinwerk Colocation GmbH"],
  },
  {
    id: "exact-term-ec-11",
    category: "exact-term",
    lang: "en",
    question: "What does edge case EC-11 say happens on a second simultaneous solve?",
    expect: ["the second request is rejected with HTTP 409"],
  },
  {
    id: "exact-term-sync-409",
    category: "exact-term",
    lang: "en",
    question: "Which app build fixes the SYNC-409 error?",
    expect: ["fix SYNC-409 ships in app build 5.12.3"],
  },

  // paraphrase
  {
    id: "paraphrase-office-days",
    category: "paraphrase",
    lang: "tr",
    question: "Hangi günler şirkete gitmem şart?",
    expect: ["Salı ve perşembe günleri ekip çekirdek günüdür"],
  },
  {
    id: "paraphrase-first-draft-speed",
    category: "paraphrase",
    lang: "en",
    question: "How quickly must the optimiser come back with an initial result?",
    expect: ["first feasible plan within 20 seconds"],
  },
  {
    id: "paraphrase-forgot-computer-in-taxi",
    category: "paraphrase",
    lang: "en",
    question: "I left my work computer in a taxi. How quickly must I tell IT?",
    expect: ["Lost or stolen devices must be reported within 2 hours"],
  },
  {
    id: "paraphrase-sla-refund",
    category: "paraphrase",
    lang: "tr",
    question: "Hizmet sık sık kesilirse müşteri para geri alabilir mi?",
    expect: ["Aylık kullanılabilirlik %99,9'un altına düşerse"],
  },
  {
    id: "paraphrase-buddy",
    category: "paraphrase",
    lang: "tr",
    question: "Yeni katılan birine ilk ayda kim eşlik ediyor?",
    expect: ["farklı ekipten ve en az bir yıldır şirkette olan biridir"],
  },
  {
    id: "paraphrase-year-end-extra-pay",
    category: "paraphrase",
    lang: "tr",
    question: "Mühendisler yıl sonunda ekstra ödeme alır mı?",
    expect: ["Mühendislik ekibinin yıllık ürün primi"],
  },
  {
    id: "paraphrase-password-expiry",
    category: "paraphrase",
    lang: "en",
    question: "Do I have to change my login secret every few months?",
    expect: ["Passwords are rotated only after a suspected compromise"],
  },

  // morphology
  {
    id: "morphology-terminate-notice",
    category: "morphology",
    lang: "tr",
    question: "Sözleşmeyi feshetmek için bildirimi nasıl göndermeliyim?",
    expect: ["Fesih bildirimi, noter aracılığıyla"],
  },
  {
    id: "morphology-my-expense",
    category: "morphology",
    lang: "tr",
    question: "Masrafımı en geç ne zamana kadar yüklemem gerekiyor?",
    expect: ["Masraflar, harcamanın yapıldığı tarihten itibaren en geç 30 gün içinde"],
  },
  {
    id: "morphology-lose-devices",
    category: "morphology",
    lang: "tr",
    question: "Cihazlarımı kaybedersem kime haber vermeliyim?",
    expect: ["en geç 2 saat içinde #guvenlik kanalı"],
  },
  {
    id: "morphology-delay-payment",
    category: "morphology",
    lang: "tr",
    question: "Ödemeyi geciktirirsek ne olur?",
    expect: ["Vadesinde ödenmeyen tutara aylık %2 gecikme faizi"],
  },
  {
    id: "morphology-oncall-pay",
    category: "morphology",
    lang: "tr",
    question: "Nöbet tutarsam ne kadar prim alırım?",
    expect: ["sabit 6.500 TL nöbet primi ödenir"],
  },
  {
    id: "morphology-leavers-accounts",
    category: "morphology",
    lang: "tr",
    question: "Çalışanlar işten ayrıldığında erişimleri ne zaman kapatılıyor?",
    expect: ["hesap erişimleri son iş günü saat 18.00'de kapatılır"],
  },
  {
    id: "morphology-resign-weeks",
    category: "morphology",
    lang: "tr",
    question: "Çalışan istifa ederken kaç hafta önceden haber vermeli?",
    expect: ["18 ay ile 36 ay arasında 6 hafta"],
  },
  {
    id: "morphology-export-data",
    category: "morphology",
    lang: "tr",
    question: "Müşteri sözleşme bitince verilerini dışa aktarabilir mi?",
    expect: ["30 gün boyunca dışa aktarılabilir"],
  },

  // cross-language
  {
    id: "cross-language-super-cap",
    category: "cross-language",
    lang: "tr",
    question:
      "Barındırma sağlayıcısının veri ihlalinde sorumluluk üst sınırı genel sınırın kaç katıdır?",
    expect: ["capped at 3 times the General Cap"],
  },
  {
    id: "cross-language-kvkk-72",
    category: "cross-language",
    lang: "tr",
    question: "Kişisel veri ihlalinde KVKK Kurumu'na kaç saat içinde bildirim yapılıyor?",
    expect: ["KVKK Kurumu) is notified within 72 hours"],
  },
  {
    id: "cross-language-routing-daily-limit",
    category: "cross-language",
    lang: "tr",
    question: "Akıllı rotalamada bir günde en fazla kaç çözüm çalıştırılabilir?",
    expect: ["Solver runs are limited to 40 per workspace per day"],
  },
  {
    id: "cross-language-cloudhost-renewal-notice",
    category: "cross-language",
    lang: "tr",
    question: "CloudHost sözleşmesini yenilememek için kaç gün önceden bildirmeliyiz?",
    expect: ["at least 180 days before the end of the then-current term"],
  },
  {
    id: "cross-language-remote-abroad",
    category: "cross-language",
    lang: "en",
    question: "How many days a year can I work from abroad?",
    expect: ["en fazla 20 iş günü Türkiye dışından çalışılabilir"],
  },
  {
    id: "cross-language-acme-availability",
    category: "cross-language",
    lang: "en",
    question: "What monthly availability does the Acme contract promise?",
    expect: ["aylık kullanılabilirliğini %99,9 olarak taahhüt eder"],
  },
  {
    id: "cross-language-september-mrr",
    category: "cross-language",
    lang: "en",
    question: "What was the monthly recurring revenue at the end of September?",
    expect: ["Eylül sonu 46.900 dolar"],
  },
  {
    id: "cross-language-runway",
    category: "cross-language",
    lang: "en",
    question: "How many months of runway does the company have at the current burn?",
    expect: ["mevcut tempoyla finansman yolu 15,9 ay"],
  },

  // table
  {
    id: "table-sku-enterprise",
    category: "table",
    lang: "en",
    question: "What is the price of PRV-ENT-0042?",
    expect: ["PRV-ENT-0042,Enterprise Yıllık 250,ENT,USD,14900.00"],
  },
  {
    id: "table-sku-storage",
    category: "table",
    lang: "tr",
    question: "PRV-ADD-0113 ek depolama kaç TL?",
    expect: ["PRV-ADD-0113,Ek Depolama 500 GB,ADD,TRY,1890.00"],
  },
  {
    id: "table-sku-starter",
    category: "table",
    lang: "en",
    question: "How much is PRV-STR-0020 Starter monthly in TRY, and how many seats?",
    expect: ["PRV-STR-0020,Starter Aylık,STR,TRY,749.00,5"],
  },
  {
    id: "table-sku-api",
    category: "table",
    lang: "tr",
    question: "PRV-API-0234 numaralı API paketinin fiyatı nedir?",
    expect: ["PRV-API-0234,API Çağrı Paketi 2M,API,USD,320.00"],
  },
  {
    id: "table-saml-sso",
    category: "table",
    lang: "en",
    question: "What does the SAML SSO add-on cost in the price list?",
    expect: ["PRV-SSO-0305,SAML SSO Eklentisi,SSO,TRY,4250.00"],
  },
  {
    id: "table-premium-support",
    category: "table",
    lang: "tr",
    question: "7/24 Premium Destek paketinin yıllık fiyatı ve SKU kodu nedir?",
    expect: ["PRV-SUP-0066,7/24 Premium Destek,SUP,USD,2100.00"],
  },
  {
    id: "table-edu-licence",
    category: "table",
    lang: "en",
    question: "How many seats and what price does the education institution licence have?",
    expect: ["PRV-EDU-0157,Eğitim Kurumu Lisansı,EDU,TRY,58000.00,400"],
  },

  // follow-up
  {
    id: "follow-up-acme-late-payment",
    category: "follow-up",
    lang: "tr",
    history: [
      { role: "user", content: "Acme sözleşmesinde faturalar ne zaman ödenir?" },
      { role: "assistant", content: "Fatura, vade tarihinden itibaren 30 gün içinde ödenir." },
    ],
    question: "peki geciktirirsek?",
    expect: ["Vadesinde ödenmeyen tutara aylık %2 gecikme faizi"],
  },
  {
    id: "follow-up-cloudhost-early-exit",
    category: "follow-up",
    lang: "en",
    history: [
      {
        role: "user",
        content:
          "How long before the end of the CloudHost term do we have to give notice of non-renewal?",
      },
      { role: "assistant", content: "At least 180 days before the end of the then-current term." },
    ],
    question: "and if we leave early instead?",
    expect: ["early-termination fee equal to 40% of the remaining committed monthly fees"],
  },
  {
    id: "follow-up-leave-carryover",
    category: "follow-up",
    lang: "tr",
    history: [
      { role: "user", content: "Yıllık izin hakkım kaç gün?" },
      {
        role: "assistant",
        content:
          "Kıdeme göre değişir; 1 ile 5 yıl arasında kıdemi olan çalışan için 16 iş günüdür.",
      },
    ],
    question: "peki ya devredebilir miyim?",
    expect: ["en fazla 3 iş günü bir sonraki yıla devredilir"],
  },
  {
    id: "follow-up-enterprise-cost",
    category: "follow-up",
    lang: "en",
    history: [
      { role: "user", content: "Which SKU is the Enterprise annual plan for 250 seats?" },
      { role: "assistant", content: "That is PRV-ENT-0042." },
    ],
    question: "and what does it cost?",
    expect: [
      "PRV-ENT-0042,Enterprise Yıllık 250,ENT,USD,14900.00",
      "Yıllık Ücret 14.900 ABD Doları",
    ],
  },
  {
    id: "follow-up-routing-over-limit",
    category: "follow-up",
    lang: "tr",
    history: [
      { role: "user", content: "Akıllı Rotalamada en fazla kaç durak girebilirim?" },
      { role: "assistant", content: "Beta sürümünde 300 durağa kadar." },
    ],
    question: "ya aşarsa?",
    expect: ["This plan is too large for Smart Routing in beta"],
  },
  {
    id: "follow-up-incident-next",
    category: "follow-up",
    lang: "en",
    history: [
      { role: "user", content: "What does the security policy say about reporting an incident?" },
      {
        role: "assistant",
        content: "Report it immediately in the security channel and to the security mailbox.",
      },
    ],
    question: "and what happens next?",
    expect: ["Step 1, Triage (within 30 minutes)"],
  },
  {
    id: "follow-up-expense-approval",
    category: "follow-up",
    lang: "tr",
    history: [
      { role: "user", content: "Masraf fişlerini ne zamana kadar yüklemeliyim?" },
      { role: "assistant", content: "Harcamadan sonra en geç 30 gün içinde." },
    ],
    question: "peki ya çok yüksekse?",
    expect: ["Tek bir fişi 2.500 TL'yi aşan her masraf için"],
  },

  // versions
  {
    id: "versions-annual-leave-1-5",
    category: "versions",
    lang: "tr",
    question: "Kıdemi 3 yıl olan bir çalışan yılda kaç gün yıllık izin kullanır?",
    expect: ["yılda 16 iş günü"],
  },
  {
    id: "versions-annual-leave-5-15",
    category: "versions",
    lang: "tr",
    question: "Kıdemi 8 yıl olan çalışanın yıllık izni kaç iş günü?",
    expect: ["yılda 22 iş günü"],
  },
  {
    id: "versions-carry-over-deadline",
    category: "versions",
    lang: "tr",
    question: "Devredilen izin günleri hangi tarihe kadar kullanılmalı?",
    expect: ["31 Mart tarihine kadar kullanılmalıdır"],
  },
  {
    id: "versions-paternity",
    category: "versions",
    lang: "tr",
    question: "İzin politikasına göre babalık izni kaç iş günü?",
    expect: ["Babalık izni: 10 iş günü ücretli izin"],
  },
  {
    id: "versions-volunteer-leave",
    category: "versions",
    lang: "en",
    question: "Is there paid leave for volunteering at a non-profit?",
    expect: ["ücretli gönüllülük izni kullanabilir"],
  },
  {
    id: "versions-unpaid-leave-cap",
    category: "versions",
    lang: "tr",
    question: "Bir yılda toplam kaç güne kadar ücretsiz izin alınabilir?",
    expect: ["toplam en fazla 45 gün ücretsiz izin"],
  },
  {
    id: "versions-sick-no-report",
    category: "versions",
    lang: "en",
    question: "How many days of sick leave can I take without a doctor's report per year?",
    expect: ["kendi beyanıyla yılda en fazla 3 iş günü"],
  },
  {
    id: "versions-leave-notice",
    category: "versions",
    lang: "tr",
    question: "Yıllık izin talebi izinden kaç iş günü önce yapılmalı?",
    expect: ["en az 7 iş günü önce yapılır"],
  },

  // negative
  {
    id: "negative-crypto-salary",
    category: "negative",
    lang: "tr",
    question: "Şirket maaşları kripto para olarak ödeyebilir mi?",
    expect: [],
    absent: "kripto para",
  },
  {
    id: "negative-parental-surrogacy",
    category: "negative",
    lang: "en",
    question: "Does the company offer parental surrogacy leave?",
    expect: [],
    absent: "parental surrogacy",
  },
  {
    id: "negative-sabbatical",
    category: "negative",
    lang: "en",
    question: "Is there a sabbatical programme after five years of service?",
    expect: [],
    absent: "sabbatical",
  },
  {
    id: "negative-company-car",
    category: "negative",
    lang: "tr",
    question: "Üst yöneticilere şirket aracı tahsis ediliyor mu?",
    expect: [],
    absent: "şirket aracı",
  },
  {
    id: "negative-office-dogs",
    category: "negative",
    lang: "en",
    question: "Can I bring my dog to the office?",
    expect: [],
    absent: "dogs",
  },
  {
    id: "negative-iso-9001",
    category: "negative",
    lang: "tr",
    question: "Şirketin ISO 9001 kalite sertifikası var mı?",
    expect: [],
    absent: "iso 9001",
  },
  {
    id: "negative-vesting",
    category: "negative",
    lang: "en",
    question: "What is the vesting schedule for employee stock options?",
    expect: [],
    absent: "vesting",
  },
  {
    id: "negative-birthday-leave",
    category: "negative",
    lang: "tr",
    question: "Doğum günü izni veriliyor mu?",
    expect: [],
    absent: "doğum günü",
  },
  {
    id: "negative-berlin-office",
    category: "negative",
    lang: "en",
    question: "Does Pervane have an office in Berlin?",
    expect: [],
    absent: "berlin",
  },
];
