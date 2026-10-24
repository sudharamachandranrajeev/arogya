# Security and safety

## Reporting
Open a private security advisory on GitHub. Do not put patient data in issues.

## What is implemented (v0.1)
- scrypt password hashing; 12-character minimum; 5-failure lockout per username and address; constant-work login for unknown users
- 12-hour server-side sessions, stored hashed; cookie is HttpOnly and SameSite=Strict (Secure when `AROGYA_SECURE_COOKIES=1`)
- CSRF defence: cookie-authenticated writes need `X-Requested-With: arogya`; no CORS is granted
- role-based access per FHIR resource type, enforced on the server
- every read, search, write, login and failed login is audited; the log is hash-chained and `GET /api/audit/verify` detects edits or deletions
- restricted patients (`meta.security` code `R` or `V`) need `X-Break-Glass-Reason`; hidden from unscoped searches otherwise
- all SQL is parameterised; security headers and a strict CSP are set; API responses are `no-store`

## Not yet done — do not use with real patient data until it is
- multi-factor authentication or OIDC single sign-on
- encryption at rest (use an encrypted disk or managed Postgres encryption for now) and an in-app backup tool
- an independent penetration test and a clinical safety case (for example DCB0129/DCB0160 in the UK)
- the drug knowledge base is illustrative only; connect a maintained formulary and interaction service
- the audit chain is tamper-*evident*, not tamper-proof: anyone with database write access could rebuild it. Ship audit rows to external append-only storage in production
