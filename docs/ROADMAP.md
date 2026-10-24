# Roadmap

The research documents rank features P0/P1/P2 for an outpatient and community release. This table maps them to what exists.

| Top pain point (from user research) | v0.1 | Next |
|---|---|---|
| Inbox overload | Pools, claim, bulk-acknowledge normal results, critical first | Auto-file normals with a patient notice; message-to-visit; response SLAs |
| Alert fatigue | Only high-severity interrupts; reason logged; override KPI | Per-rule override analytics, auto-retire noisy rules |
| Note bloat, after-hours charting | Short note with phrases; word count | Provenance on carried-forward text; "what changed" view; after-hours metric |
| Lost referrals / "unknown queue" | Referral task, waiting list, breach ordering | Referral-out loop closure, stuck-work board, receipt states |
| Scheduling gaps, no-shows | Race-safe booking, backfill ranking, DNA risk | SMS/email reminders, patient self-booking, recall lists, overbooking advice |
| Duplicate records | Duplicate warning on registration | Merge workflow, probabilistic matching |
| Slow, click-heavy UI | `/` search, one-call chart | Click budgets in CI, command palette, p95 latency SLO |
| Downtime and poor connectivity | None | Offline-first replica, downtime pack, CHW mobile client with sync |
| Interoperability | FHIR R4 REST, NDJSON export | Transaction bundles, SMART on FHIR, bulk `$export`, HL7 v2 ADT/ORM/ORU, IPS |
| Billing | None | Fee schedule, invoices, exemptions, charge capture |
| Terminology | Free text plus optional codes | SNOMED CT / LOINC / ICD / dm+d services, form builder |
| Access and identity | Roles, break-glass, audit | MFA/OIDC, location-scoped access, patient portal with consent |
| Low-resource settings | Runs on a laptop with embedded Postgres | Multilingual UI, SMS workflows, programme registers (TB, HIV, ANC, NCD), DHIS2 export |
| Inpatient | None | ADT, bed management, MAR, nursing flowsheets, order sets |
| AI help | None | Ambient scribe and inbox drafting, behind explicit clinician review |
