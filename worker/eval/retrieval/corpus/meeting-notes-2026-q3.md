# Pervane meeting notes, Q3 2026

Notes kept by whoever takes them that week. Mostly English; Turkish where the room spoke Turkish. Action items are written as "AI:" followed by owner and due date.

## 2026-07-02 Weekly leadership sync

Attendees: Ayşe Demirtaş (CEO), Kemal Aksoy (CTO), Selin Karaca (Finance & People), Burak Yurt (Sales lead), Deniz Arslan (Product).

Agenda: June close, hiring, routing beta.

- June closed with MRR at 412,000 TRY-equivalent... correction from Selin: MRR is reported in USD, 41,300 USD at end of June, up from 38,900 in May.
- Burak reported 3 deals in contract stage: a Bursa cold-chain distributor (120 seats), a Konya agricultural cooperative (60 seats) and a Mersin port services company (200 seats). The Mersin deal needs SAML SSO before signature.
- Decision: we will not discount Enterprise annual plans below the list price of 14,900 USD for 250 seats. Burak may offer 2 free training days instead.
- Hiring: two backend engineers and one customer success manager are open. Decision: freeze the designer role until the routing beta ships.
- AI: Selin to send the June investor update by 8 July.
- AI: Deniz to share the routing beta scope doc by 6 July.

## 2026-07-16 Routing beta kickoff

Attendees: Kemal, Deniz, Cem Özdemir (backend), Elif Tunç (frontend), Gizem Polat (QA).

Kemal explained that the Smart Routing feature has to ship in beta to five design-partner customers by 15 September. Cem presented the solver design: a vehicle routing heuristic with time windows, running on a queue so a 500-stop plan finishes in under 90 seconds.

- Decision: beta runs only for plans of up to 300 stops. Plans above 300 stops show a message and fall back to the old manual planner.
- Decision: we keep the heuristic solver in-house rather than buying a third-party optimisation API. The quoted price from the vendor was 0.012 USD per stop, which at our projected volumes is 14,000 USD per month.
- Elif raised the map-tile cost; Deniz said the budget cap for tiles is 1,800 USD per month.
- Gizem will build a regression set of 40 real-shaped routes (invented, from synthetic data) before the beta.
- AI: Cem to prototype the solver queue by 31 July.
- AI: Gizem to deliver the regression set by 7 August.
- AI: Elif to design the "unassigned stops" panel by 24 July.

## 2026-07-30 Weekly leadership sync

Short meeting. Ayşe is travelling to Ankara for the municipality tender. Kemal reported the CloudHost renewal notice deadline of 2 September for the 36-month agreement: decision is to send non-renewal notice only if the re-quote is not at least 8% cheaper. Selin will ask two alternative vendors for quotes.

- The Konya cooperative signed on 28 July, 60 seats, Professional plan, paid annually.
- Churn: one small customer (12 seats) cancelled citing budget. Reason recorded in CRM.
- AI: Selin to collect two alternative hosting quotes by 21 August.
- AI: Burak to follow up with Mersin on the SSO timeline, by 3 August.

## 2026-08-06 Support retrospective

Attendees: Nilüfer Kaya (support lead), Taner Güneş, Rabia Şen, Deniz, Kemal.

Nilüfer showed that July tickets were 412, up 19% from June, with the main driver being 87 tickets on the driver mobile app's offline sync. Median first response was 41 minutes against the 60-minute target; the median time to resolution was 9.2 hours.

- Top three categories: offline sync (87), invoice export (54), user invitation emails not arriving (39).
- Decision: the offline sync bug becomes priority one for the mobile squad; fix by end of August.
- Invitation emails: the sending domain was missing a DKIM record for a secondary mail provider. Taner fixed it on 4 August.
- Rabia proposed a self-service status page. Decision: Deniz will scope it for Q4, not Q3.
- AI: Kemal to assign two engineers to offline sync starting 10 August.
- AI: Nilüfer to publish the macro responses for invoice export in the help centre by 14 August.
- AI: Taner to document the DKIM and SPF setup in the runbook by 12 August.

## 2026-08-13 Pricing review

Attendees: Ayşe, Burak, Deniz, Selin.

Selin brought the pricing sheet (fiyat-listesi.csv). Observed: the TRY prices were set at a rate of 38.5 TRY per USD in January and the lira has moved; the effective discount for TRY-paying customers is now about 17%.

- Decision: update the TRY column to 41.0 per USD from 1 October for new contracts; existing contracts keep their rate until renewal.
- Decision: add an annual 20% prepayment discount for Starter and Professional only, not for Enterprise.
- Proposal rejected: usage-based API pricing. Burak said customers prefer fixed packages; Ayşe agreed. We will still bill overage above the package, as in the Acme contract (60 USD per additional million calls).
- Edu pricing: the education licence stays at 58,000 TRY per year for 400 seats. Nobody has signed it yet; Deniz will check demand at the university fair.
- AI: Selin to regenerate the price list by 25 September.
- AI: Burak to notify the three TRY-paying enterprise accounts of the renewal change by 30 September.

## 2026-08-27 Toplantı: Mersin liman müşterisi

Katılanlar: Burak, Kemal, Cem, Mersin tarafından Orhan Taşkın (BT müdürü) ve iki kişi.

Orhan Bey SAML SSO'nun Eylül sonuna kadar hazır olmasını istedi, aksi halde imzayı 2027'ye bırakacaklarını söyledi. Kemal, SSO'nun Azure AD ile test edildiğini, Okta için ise hâlâ doğrulama beklediğini belirtti.

- Karar: SAML SSO eklentisi Mersin pilotu için ücretsiz verilecek, ilk yıl sonunda aylık 4.250 TL'den faturalanacak.
- Müşterinin ilk talebi veri yerleşimini Türkiye'de tutmaktı; Kemal İstanbul bölgesinin kullanılabilir olduğunu, ancak yedeklerin Frankfurt'ta kalacağını söyledi.
- Mersin tarafı sözleşmede fesih maddesinin ilk 12 ay için tazminatsız olmasını istedi; Burak bunu kabul etmeden önce Ayşe'ye soracağını söyledi.
- AI: Cem, Okta doğrulamasını 11 Eylül'e kadar bitirecek.
- AI: Burak, sözleşme taslağını 4 Eylül'e kadar gönderecek.
- AI: Kemal, veri yerleşimi için bir sayfalık teknik not yazacak, 3 Eylül.

## 2026-09-03 Weekly leadership sync

Attendees: Ayşe, Kemal, Selin, Burak, Deniz.

- August MRR: 44,700 USD. Net new MRR 3,400, churned 600, expansion 1,100.
- Mersin contract draft went out on 4 Sept as planned? Burak says it goes tomorrow; slipped one day.
- CloudHost: the renewal quote arrived at 6.2% above current. Decision: do not send non-renewal; instead negotiate for the 2% volume rebate offered in 2025. Kemal will call Mert Aydoğdu. (Notice window closed 2 September; clause 12.1 means the agreement renews to 28 February 2028.)
- Security: Gizem found that two laptops did not have disk encryption enabled. Both fixed the same day. Decision: the MDM report becomes a monthly review item for Selin.
- Decision: the next team offsite will be on 23–24 October in Şile, budget 95,000 TRY, excluding travel.
- AI: Kemal to renegotiate CloudHost by 17 September.
- AI: Selin to start the MDM monthly review on 1 October.
- AI: Ayşe to book the Şile venue by 10 September.

## 2026-09-10 Routing beta readiness

Attendees: Kemal, Deniz, Cem, Elif, Gizem, Nilüfer.

The beta is on track for 15 September. Gizem ran the regression set: 37 of 40 routes passed the quality bar (total drive time within 5% of the reference). The three failures involved multi-depot plans.

- Decision: multi-depot routing is out of scope for the beta and goes on the Q4 roadmap as REQ-31.
- Decision: five design partners were selected: the Bursa cold-chain distributor, a Gaziantep bakery chain, the Acme logistics team, an Izmir pharmacy wholesaler and a Trabzon hazelnut exporter.
- Nilüfer asked for an in-app feedback button; Elif will add one that posts to #destek.
- Open question: timeouts for plans above 250 stops, because the solver queue showed p95 of 74 seconds at 250 stops and 128 seconds at 300 stops. Decision pending Cem's tuning; if p95 stays above 90 seconds the beta limit drops from 300 to 250 stops.
- AI: Cem to tune the solver by 14 September.
- AI: Elif to ship the feedback button by 14 September.
- AI: Nilüfer to brief the support team on the beta by 14 September.

## 2026-09-17 Weekly leadership sync

Attendees: Ayşe, Kemal, Selin, Burak, Deniz.

- Beta launched on 15 September to the five design partners. First-day feedback: 11 comments, 7 positive, 4 asking about multi-depot.
- Cem's tuning worked: the p95 is 71 seconds at 300 stops, so the 300-stop limit stays.
- Series A preparation: Ayşe will meet 4 investors in October. Selin to refresh the investor report with the Q3 numbers by 12 October.
- Hiring update: the two backend engineers start on 1 October and 15 October; the customer success manager offer was accepted and she starts 5 October.
- Decision: the designer role stays frozen until the end of the beta.
- AI: Selin to circulate the Q3 investor report draft by 12 October.
- AI: Kemal to define the beta exit criteria by 24 September.

## 2026-09-24 Beta exit criteria and retro

Attendees: Kemal, Deniz, Cem, Elif, Gizem.

Exit criteria for the Smart Routing beta, agreed today: (1) at least four of five design partners use it weekly for three consecutive weeks; (2) fewer than 5 severity-2 bugs open; (3) p95 solve time under 90 seconds at 300 stops; (4) a positive answer from at least three partners to "would you pay for this?". Deniz suggested pricing Smart Routing as an add-on at 480 USD per month, but the pricing review will decide.

- Decision: beta review on 20 October; general availability not before 3 November.
- AI: Gizem to automate the regression set in CI by 8 October.
- AI: Deniz to run the willingness-to-pay interviews with all five partners by 15 October.
