# Roadmap

The research documents rank features P0/P1/P2 for an outpatient and community release. This table maps them to what exists.

| Top pain point (from user research) | Done (v0.1–v0.3) | Next |
|---|---|---|
| Inbox overload | Pools, claim, bulk-acknowledge normal results, critical first, response SLAs with overdue flags, unclosed critical results escalated after an hour | Auto-file normals with a patient notice; message-to-visit |
| Alert fatigue | Only high-severity interrupts; reason logged; override KPI; per-rule override analytics flag noisy rules; clinicians stop noisy rules interrupting with a logged reason | Local formulary of rule severities; patient-specific suppression |
| Note bloat, after-hours charting | Short note with phrases; word count; drafts kept; blanks block signing; signing closes the visit | Provenance on carried-forward text; "what changed" view; after-hours metric |
| Lost referrals / "unknown queue" | Referral task, waiting list, breach ordering, stuck-work board | Referral-out loop closure, receipt states |
| Scheduling gaps, no-shows | Race-safe booking, backfill ranking, DNA risk, recall lists for long-term conditions with booking from the list | SMS/email reminders, patient self-booking, overbooking advice |
| Duplicate records | Scored duplicate warning on registration, duplicates worklist, reversible merge with history | Cross-site matching, Patient `$match` |
| Slow, click-heavy UI | `/` search, one-call chart, command palette, keyboard navigation, Today list, browser walk-through in CI | Click budgets in CI, p95 latency SLO |
| Downtime and poor connectivity | None | Offline-first replica, downtime pack, CHW mobile client with sync |
| Interoperability | FHIR R4 REST, NDJSON export | Transaction bundles, SMART on FHIR, bulk `$export`, HL7 v2 ADT/ORM/ORU, IPS |
| Billing | None | Fee schedule, invoices, exemptions, charge capture |
| Terminology | Free text plus optional codes | SNOMED CT / LOINC / ICD / dm+d services, form builder |
| Access and identity | Roles, break-glass, audit, TOTP two-step (required per role), idle lock, admin data minimisation, access report, encrypted backups | OIDC, passkeys, location-scoped access, patient portal with consent |
| Low-resource settings | Runs on a laptop with embedded Postgres | Multilingual UI, SMS workflows, programme registers (TB, HIV, ANC, NCD), DHIS2 export |
| Inpatient | None | ADT, bed management, MAR, nursing flowsheets, order sets |
| AI help | None | Ambient scribe and inbox drafting, behind explicit clinician review |
