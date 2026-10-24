# Master Services Agreement: CloudHost Infrastructure

Agreement no. CH-MSA-2024-0932. Between Pervane Yazılım A.Ş. ("Customer") and Bulutkale Hosting Ltd. ("CloudHost", a fictional vendor). Effective date: 1 March 2024. Initial term: 36 months. This agreement is invented for testing purposes.

## 1. Definitions

1.1 "Services" means the virtual machines, managed database clusters, object storage, load balancers and network services described in Order Form 1.
1.2 "Customer Data" means all data Customer or its end users store on or transmit through the Services.
1.3 "Uptime Commitment" means the monthly availability percentages in Schedule B.
1.4 "Confidential Information" means non-public information disclosed by one party to the other that is marked confidential or would reasonably be understood to be.
1.5 "Security Incident" means a confirmed unauthorised access to, or loss of, Customer Data in CloudHost's control.

## 2. Services and Order Forms

2.1 CloudHost shall provide the Services in the Frankfurt (FRA-2) and Istanbul (IST-1) regions. Customer may add regions by written order.
2.2 Reserved capacity under Order Form 1 is 48 vCPU, 192 GB RAM, 4 TB block storage and 20 TB object storage, billed monthly in advance.
2.3 Customer may increase reserved capacity by up to 25% in any calendar quarter on 10 business days' notice, at the unit rates in Schedule A.
2.4 CloudHost may not reduce the committed capacity or move Customer workloads to another data centre without 60 days' written notice.

## 3. Fees and payment

3.1 Monthly fees are USD 6,480 for reserved capacity plus usage above reserved levels at the rates in Schedule A. Fees are invoiced on the first day of each month.
3.2 Undisputed invoices are payable within 45 days of the invoice date. Late payments accrue interest at 1.5% per month.
3.3 Customer may dispute an invoice in good faith within 21 days by written notice; the undisputed portion remains payable.
3.4 CloudHost may increase fees on renewal by no more than 7% per renewal term, on at least 120 days' written notice.
3.5 Taxes are separate. Customer is responsible for withholding taxes that apply to cross-border payments and shall provide a withholding certificate on request.

## 4. Service levels

4.1 CloudHost commits to 99.95% monthly availability for the managed database cluster and 99.9% for compute and object storage.
4.2 If availability falls below the commitment, Customer receives service credits: 10% of that month's fees for availability between 99.0% and the commitment, 25% between 95.0% and 99.0%, and 50% below 95.0%.
4.3 Credits must be requested within 30 days after the end of the affected month. Credits are the sole remedy for failure to meet the Uptime Commitment, except where Customer has the right to terminate under clause 12.3.
4.4 Scheduled maintenance of up to 6 hours per month is excluded and shall be announced at least 5 days ahead.

## 5. Data protection and processing

5.1 CloudHost acts as a processor of personal data contained in Customer Data. A data processing addendum (Schedule C) applies and forms part of this agreement.
5.2 CloudHost shall process personal data only on Customer's documented instructions, implement measures consistent with ISO 27001, and ensure that personnel are bound by confidentiality.
5.3 CloudHost shall notify Customer of a Security Incident without undue delay and in any event within 36 hours of confirmation, including the nature of the incident, categories of data and the measures taken.
5.4 Sub-processors are listed in Schedule C. CloudHost shall give 30 days' notice of a new sub-processor; Customer may object on reasonable data-protection grounds, in which case the parties shall discuss alternatives in good faith.
5.5 Customer Data shall remain in the regions named in clause 2.1. Transfers outside the European Economic Area and Türkiye require Customer's prior written consent.
5.6 On termination, CloudHost shall make Customer Data available for retrieval for 30 days and then delete it within 45 days, certifying the deletion in writing.
5.7 Backups are encrypted with AES-256 and retained for 35 days; backup snapshots are stored in a region different from the primary.

## 6. Security obligations

6.1 CloudHost shall maintain physical access controls, biometric entry to data halls, 24/7 staffed monitoring and CCTV retention of 90 days.
6.2 Customer is responsible for configuration of its own virtual machines, application-level access control and the safe handling of access keys.
6.3 CloudHost shall make a SOC 2 Type II report and a penetration-test summary available to Customer once per year on request, under the confidentiality terms of clause 8.
6.4 Customer may carry out its own vulnerability scanning of its environment with 5 business days' notice, provided that it does not affect other tenants.

## 7. Intellectual property

7.1 Each party retains its intellectual property. Nothing in this agreement transfers ownership of Customer Data or Customer's software to CloudHost.
7.2 Customer grants CloudHost the right to host, copy and process Customer Data solely to provide the Services.

## 8. Confidentiality

8.1 Each party shall protect the other's Confidential Information with at least reasonable care and use it only to perform or receive the Services.
8.2 The obligation lasts for the term and 3 years afterwards; for trade secrets it lasts as long as the information remains a trade secret.
8.3 Disclosure required by law or a court order is permitted after prompt notice where legally allowed.

## 9. Warranties and disclaimers

9.1 CloudHost warrants that it will perform the Services with reasonable skill and care and in accordance with the specifications in the Order Forms.
9.2 Except as expressly stated, the Services are provided "as is", and CloudHost disclaims all implied warranties of merchantability and fitness for a particular purpose.

## 10. Indemnification

10.1 CloudHost shall defend Customer against third-party claims alleging that the Services infringe intellectual property rights, and pay damages finally awarded or agreed in settlement.
10.2 Customer shall defend CloudHost against claims arising from Customer Data or Customer's breach of the acceptable use policy.
10.3 The indemnified party shall give prompt notice, sole control of the defence and reasonable assistance.

## 11. Limitation of liability

11.1 Each party's total aggregate liability arising out of this agreement shall not exceed the fees paid or payable in the 12 months before the claim arose (the "General Cap").
11.2 For breaches of clause 5 (data protection) and Security Incidents caused by CloudHost's failure to follow clause 6.1, CloudHost's liability is capped at 3 times the General Cap (the "Super Cap"), which at current fees is approximately USD 233,280.
11.3 Neither party is liable for indirect or consequential loss, loss of profit or loss of goodwill. This exclusion does not apply to the Super Cap amounts for data-protection breaches, to indemnities under clause 10.1, or to fraud and wilful misconduct.
11.4 Nothing in this agreement limits liability that cannot be limited by law.

## 12. Term, renewal and termination

12.1 The agreement renews automatically for successive 12-month terms unless either party gives written notice of non-renewal at least 180 days before the end of the then-current term. For the initial term ending 28 February 2027, notice must therefore reach CloudHost by 2 September 2026.
12.2 Either party may terminate for material breach if the breach is not remedied within 30 days of written notice.
12.3 Customer may terminate on 30 days' notice, without liability for early-termination fees, if availability of the managed database cluster falls below 99.0% in any two months of a rolling six-month period, or if a Security Incident results from CloudHost's breach of clause 6.1.
12.4 Customer may terminate for convenience during the initial term with 120 days' written notice, subject to an early-termination fee equal to 40% of the remaining committed monthly fees.
12.5 Upon termination or expiry, clause 5.6 (data retrieval and deletion) shall apply, and CloudHost shall provide up to 40 hours of reasonable migration assistance free of charge.
12.6 The termination provisions of this agreement are distinct from any customer contract Customer signs with its own clients, whose termination (fesih) rights are separate and not affected by this agreement.

## 13. Force majeure

13.1 Neither party is liable for delay caused by events beyond its reasonable control, including natural disaster, war, pandemic, widespread power or network failure and governmental action.
13.2 If force majeure continues for more than 45 days, either party may terminate the affected Order Form on written notice.

## 14. Notices and governing law

14.1 Notices shall be in writing and sent to the addresses in the Order Form, with a copy by email to legal@pervane.test and contracts@bulutkale.test.
14.2 This agreement is governed by the laws of England and Wales. The courts of London have exclusive jurisdiction, except that either party may seek injunctive relief in any competent court.

## Schedule A: Unit rates (excerpt)

Additional vCPU: USD 22.00 per vCPU per month. Additional RAM: USD 4.50 per GB per month. Block storage: USD 0.11 per GB per month. Object storage: USD 0.019 per GB per month, with egress free up to 10% of stored volume and USD 0.04 per GB beyond. Dedicated IPv4 address: USD 3.00 per address per month. Managed database replica: USD 310 per replica per month.

## Schedule B: Availability measurement

Availability is measured at one-minute intervals by CloudHost's monitoring from three external vantage points. A minute is unavailable when two of the three vantage points fail to complete a health check within 10 seconds. Monthly availability equals total minutes minus unavailable minutes, divided by total minutes. CloudHost shall publish measurements in its status portal and keep data for 13 months.

## Schedule C: Data processing addendum (summary)

Subject matter: hosting of Customer's production application and database. Duration: term of the agreement plus the retrieval period in clause 5.6. Categories of data subjects: Customer's employees, Customer's clients' employees and drivers. Types of data: names, work email addresses, phone numbers, location traces. Sub-processors as of 1 March 2024: Rheinwerk Colocation GmbH (Frankfurt data hall), Marmara Veri Merkezi A.Ş. (Istanbul data hall), Kuzey Ağ Hizmetleri (network transit).

## Schedule D: Support

Severity 1 (production unavailable): response within 15 minutes, 24/7, with updates every 30 minutes. Severity 2: response within 2 hours. Severity 3: response within 1 business day. Support is available by phone, ticket portal and the named technical account manager, Mert Aydoğdu. Customer may nominate up to 6 authorised contacts.

## Schedule E: Renewal history and commercial notes

At signing the parties agreed that the first renewal term would carry a price cap of 7%. Customer asked in July 2025 whether the reserved capacity could be reduced by 12 vCPU; CloudHost declined under clause 2.4 but offered a 2% volume rebate if Customer committed to the second renewal term in writing before 1 June 2026. This offer expired unaccepted.
