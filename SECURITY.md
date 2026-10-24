# Security and safety

## Reporting
Open a private security advisory on GitHub. Do not put patient data in issues.

## What is implemented (v0.5)
- scrypt password hashing; 12-character minimum; 5-failure lockout per username and address; constant-work login for unknown users
- two-step verification (TOTP, RFC 6238); codes are single-use; secrets are sealed with AES-256-GCM under an application key; an administrator can require it per role, and those users cannot open anything until they enrol
- server-side sessions, stored hashed, ending after 30 idle minutes (12 hours at most); the client locks the screen after 10 idle minutes; changing a password, role or two-step status ends other sessions; cookie is HttpOnly and SameSite=Strict (Secure when `AROGYA_SECURE_COOKIES=1`)
- CSRF defence: cookie-authenticated writes need `X-Requested-With: arogya`; no CORS is granted
- role-based access per FHIR resource type, enforced on the server
- every read, search, write, login and failed login is audited; the log is hash-chained and `GET /api/audit/verify` detects edits or deletions
- restricted patients (`meta.security` code `R` or `V`) need `X-Break-Glass-Reason`. Every result is checked against its owner's labels, so no query spelling (comma lists, odd reference prefixes) gets round it; labels survive deletion of the patient; only clinicians can change them (logged as `security-label-change`); registration search shows `R` patients as a name stub and hides `V` patients
- bulk export follows the type's read rights, needs two-step verification and leaves out restricted records
- appointment clashes are refused on every path (book, FHIR write, un-cancel), compared as timestamps under a per-clinician lock; FHIR writes are single transactions
- `node server/main.ts check` and the daily Integrity card verify the audit chain and its head, search index, history, references, open work, bookings, keys and backups
- reply webhook: HMAC over `timestamp.body`, five-minute window, each gateway message acted on once
- restricted records are left out of shared worklists (recalls, duplicates) and cannot be merged from the worklist; a merge or unmerge is audited against both records, with the reason
- reminder texts carry no clinical detail and are never sent for restricted records; the gateway URL must be https (http only to this machine), redirects are refused, and each request is signed with HMAC-SHA256 using a secret sealed under the application key and shown once
- administrators cannot read clinical resources (data minimisation); they can list who accessed a patient's record
- encrypted backups (scrypt-derived key, AES-256-GCM); the in-app download needs an administrator with two-step on
- all SQL is parameterised; HSTS is sent when secure cookies are on; security headers and a strict CSP are set; API responses are `no-store`

## Not yet done — do not use with real patient data until it is
- OIDC single sign-on and WebAuthn passkeys
- encryption at rest for the live database (use an encrypted disk or managed Postgres encryption for now)
- an independent penetration test and a clinical safety case (for example DCB0129/DCB0160 in the UK)
- the drug knowledge base is illustrative only; connect a maintained formulary and interaction service
- the audit chain is tamper-*evident*, not tamper-proof: anyone with database write access could rebuild it. Ship audit rows to external append-only storage in production
