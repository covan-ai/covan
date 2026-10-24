# Pervane Information Security Policy

Version 2.4, effective 1 April 2026. Owner: Kemal Aksoy (CTO). Reviewer: Gizem Polat (QA and security champion). Applies to all employees, contractors and any device or account used to access Pervane systems or customer data. A shorter Turkish summary is in the employee handbook.

## 1. Purpose and scope

This policy sets the minimum controls Pervane applies to protect customer data, source code and company information. It covers authentication, devices, access control, data handling, vendors, logging and incident response. Exceptions need written approval from the CTO and are reviewed every 90 days.

## 2. Accounts and passwords

2.1 Every employee has a single sign-on identity. Shared accounts are not allowed except for the break-glass accounts described in 2.7.
2.2 Passwords must be at least 14 characters long. Complexity rules are not enforced; length and uniqueness are. A password must never be reused across systems.
2.3 All employees must use the company password manager. Master passwords are not recoverable by IT; employees are asked to set up the recovery kit during onboarding.
2.4 Passwords are rotated only after a suspected compromise, not on a calendar schedule. Passwords found in a public breach list are rejected at the time of setting.
2.5 Multi-factor authentication is mandatory for email, the source code platform, the cloud console, the password manager and the customer support tooling. SMS codes are not accepted as a second factor; hardware keys or authenticator apps are required.
2.6 Production access for engineers requires a hardware security key. Keys are issued in pairs (one primary, one backup) and the backup is stored in the office safe.
2.7 Two break-glass accounts exist for the cloud console. Their credentials are sealed in the office safe, split between the CTO and the CEO. Every use triggers an alert and a post-use review within 2 business days.
2.8 Accounts of departing employees are disabled at 18:00 on their last working day and deleted after 30 days.

## 3. Devices and endpoint protection

3.1 All laptops use full-disk encryption (FileVault on macOS, BitLocker on Windows). Unencrypted devices must not connect to company systems. The MDM monthly report lists non-compliant devices, and the finance and people lead reviews it on the first working day of each month.
3.2 Screens lock automatically after 5 minutes of inactivity. A lock screen password or biometric is required.
3.3 Operating systems and browsers must be updated within 14 days of a security update release; critical updates within 72 hours. MDM can force a restart after the deadline.
3.4 Personal phones may read company email only if the MDM profile is installed, which enforces a 6-digit passcode, encryption and remote wipe of the work profile.
3.5 USB mass-storage devices are blocked by default on company laptops. Exceptions are granted for 7 days at a time by the CTO.
3.6 Lost or stolen devices must be reported within 2 hours. IT remotely locks and wipes the device and rotates any credentials that were stored on it.
3.7 Endpoint detection software runs on every laptop. A detection with severity "high" opens an incident automatically.

## 4. Access control and least privilege

4.1 Access to systems is granted by role. Engineers receive read access to production logs by default; write access to production databases is granted only for a time-boxed task and expires after 8 hours.
4.2 Customer data in production is accessed only for support or incident work, with a ticket reference. Every access is logged.
4.3 Access reviews are performed quarterly by team leads. Stale access found in a review is removed within 5 business days.
4.4 Source code is stored in the company's source control platform. The main branch is protected; every change needs one review and a passing build. Secrets are never committed; a secret scanner runs on every push.
4.5 Service accounts use short-lived credentials where the platform supports it; otherwise they are rotated every 90 days.

## 5. Data classification and handling

5.1 Data is classified as Public, Internal, Confidential or Restricted. Customer Data and credentials are Restricted.
5.2 Restricted data is encrypted in transit (TLS 1.2 or higher) and at rest (AES-256). Backups are encrypted and retained for 35 days.
5.3 Production data must not be copied to laptops or used in development or test environments. Test environments use synthetic data.
5.4 Customer exports requested by support are delivered through expiring links of 7 days with a one-time password.
5.5 Paper documents containing Restricted data are shredded. The office keeps no customer data on paper by design.

## 6. Vendors and third parties

6.1 Vendors that process Customer Data are reviewed before onboarding: security questionnaire, certifications (ISO 27001 or SOC 2 Type II), data location and sub-processors.
6.2 A data processing agreement is signed with every such vendor. The vendor list is published on the company website and updated 30 days before a change takes effect.
6.3 Vendors are re-reviewed annually. The hosting vendor's contract has its own breach notification clause of 36 hours.

## 7. Logging and monitoring

7.1 Authentication events, administrative actions and production data access are logged centrally and kept for 13 months.
7.2 Alerts exist for: impossible-travel logins, repeated failed logins (5 within 10 minutes), disabling of MFA, creation of new API keys with production scope, and use of break-glass accounts.
7.3 Logs are write-once for employees; only the CTO and the security champion can configure retention.

## 8. Incident response

8.1 A security incident is any event that compromises or may compromise the confidentiality, integrity or availability of Pervane or customer data. Anyone who suspects an incident reports it immediately in the #guvenlik channel and to guvenlik@pervane.test. Reporting in good faith never leads to disciplinary action.
8.2 Response steps:
- Step 1, Triage (within 30 minutes): the on-call engineer opens an incident ticket, assigns a severity (SEV1 to SEV3) and names an incident commander.
- Step 2, Contain (within 2 hours for SEV1): isolate affected systems, revoke exposed credentials, block malicious sources. Do not delete evidence; snapshot first.
- Step 3, Investigate: establish what happened, what data was involved, and for how long. The commander keeps a timeline in the incident ticket.
- Step 4, Notify: the CEO and the data protection officer are informed within 4 hours of a SEV1. Affected customers are informed without undue delay and within 48 hours of confirmation for customer-data incidents, as set by the customer contracts. The Turkish data protection authority (KVKK Kurumu) is notified within 72 hours of the company becoming aware of a personal data breach.
- Step 5, Recover: restore from known-good backups, rotate secrets, verify with monitoring for 72 hours before closing.
- Step 6, Review: a blameless post-incident review is held within 5 business days and its action items are tracked to completion.
8.3 Severity definitions. SEV1: confirmed customer data exposure or total production outage over 30 minutes. SEV2: suspected exposure, partial outage, or compromise of an employee account without evidence of data access. SEV3: policy violation or minor event with no data impact.
8.4 The incident commander is the single decision maker during an incident. External communication is approved by the CEO.
8.5 Incident response exercises (tabletop) are held twice a year; the last one was on 11 February 2026 and simulated a leaked API key.

## 9. Business continuity

9.1 The production database has point-in-time recovery of 7 days and a daily snapshot retained for 35 days in a second region. A restore test is performed every quarter; the target recovery time is 4 hours and the recovery point objective is 15 minutes.
9.2 The status page is hosted separately from production infrastructure.

## 10. Awareness and training

10.1 New employees complete security onboarding on their first day and sign this policy.
10.2 All employees complete a 45-minute security awareness course every year and a phishing simulation twice a year. Repeated failures lead to a coaching conversation, not a penalty.
10.3 Engineers complete an additional secure-coding workshop every year.

## 11. Remote work and travel

11.1 Public Wi-Fi may be used only through the company VPN. Employees travelling to countries on the CTO's high-risk list use a clean loaner laptop with no access to production.
11.2 Screen privacy filters are provided on request. Confidential calls are not taken in public places.

## 12. Policy review

This policy is reviewed every 12 months, or after a SEV1 incident. Questions go to guvenlik@pervane.test.
