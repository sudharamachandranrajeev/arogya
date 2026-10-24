# Arogya

Arogya (आरोग्य, "health") is an open-source, FHIR-native electronic health record. It is built to remove the daily waste that clinicians, clerks, managers and patients report in existing systems.

**Status: v0.3, pre-release.** It is a working foundation for outpatient and community care. It is **not** certified, has not had a clinical safety review, and must not hold real patient data until your organisation has done its own safety, security and governance assessment. See [SECURITY.md](SECURITY.md).

## What it does today

| Area | Features |
|---|---|
| **Today** | The clinician's day in one list: arrival, did-not-attend and *Start visit*, which opens the chart and closes the appointment when the note is signed. Allergy counts shown before you open a record |
| **Registration and identity** | Fuzzy patient search (name, ID, phone, date of birth), restricted-record flag. Duplicate warning at registration and a **possible-duplicates worklist** with a transparent match score (date of birth, similar names, phone, identifier, sex). **Reversible merge**: everything is re-pointed to the kept record with history preserved, old ID numbers still find the person, and a merge can be undone |
| **Chart** | One-call chart summary: allergies, problems, medications, vitals, results, referrals, appointments, notes. Short notes with `.dot` phrase shortcuts; drafts survive a reload; a note with unfilled `___` blanks cannot be signed. One-step vitals entry. Trend sparklines for results and vitals |
| **Prescribing** | Allergy, interaction, duplicate-therapy and maximum-daily-dose checks. Only *high-severity* alerts interrupt; they need a logged reason to override. Override rate is a KPI |
| **Results** | Numeric results are auto-flagged against their own reference range and critical limits. Results route to the orderer's inbox. Critical results sort first. A critical result nobody has closed within an hour is escalated to the shared results pool |
| **Inbox** | Shared work pools (results, messages, triage, scheduling) plus personal queues. **Acknowledge all normal results in one click**; abnormal results are never bulk-closed |
| **Recalls** | Long-term condition monitoring (for example HbA1c in diabetes, eGFR in kidney disease): who is overdue, never tested or due within a month, and whether they are already booked. Book straight from the list. The chart shows what is due while the patient is in the room. Rules and intervals are set locally |
| **Referrals and waiting list** | Priority targets (editable), days-to-breach, breach-ordered worklist |
| **Scheduling** | Clinic sessions generate slots. Booking is race-safe (two receptionists cannot take one slot). A cancelled or missed appointment creates a *fill this slot* task with ranked waiting-list candidates |
| **No-show risk** | Transparent score with the reasons shown to the scheduler |
| **Dashboard** | Waiting list size, average and longest wait, breaches, DNA and cancellation rates, lost slots, inbox age and overdue work, result turnaround, alert overrides. A *stuck work* board lists unclaimed and overdue tasks. Per-rule alert analytics flag rules that are almost always overridden; a clinician can stop a flagged rule interrupting (with a logged reason, reversible). Allergy alerts always interrupt |
| **Security** | Role-based access, scrypt passwords, lockout, session cookies (HttpOnly, SameSite=Strict), CSRF header, **hash-chained tamper-evident audit log**, **break-glass** access with a stated reason. **Two-step verification** (TOTP), which an administrator can require per role. Sessions end after 30 idle minutes; the screen locks after 10. **Encrypted backups** (AES-256-GCM). Administrators manage users and audit but **cannot open clinical records**; they can see who opened a record |
| **Ease of use** | Command palette (`Ctrl+K` or `/`), `g` then a letter to jump between pages, `Ctrl+Shift+L` to lock. Light and dark themes, motion that respects *reduce motion* |
| **Interoperability** | FHIR R4 REST for 26 resource types: read, vread (`_history/{version}`), create, update (with `If-Match`), delete, search, history, `CapabilityStatement`. NDJSON export |

Details of the research behind these choices: [docs/research/user-pain-points.md](docs/research/user-pain-points.md) and [docs/research/feature-inventory.md](docs/research/feature-inventory.md). The mapping and what is still missing: [docs/ROADMAP.md](docs/ROADMAP.md).

## Run it

Needs Node.js 24 or newer. No database setup is required: without `DATABASE_URL` it uses an embedded PostgreSQL (PGlite) stored in `.data/`.

```sh
npm ci
npm run build
AROGYA_DEMO=1 npm start        # synthetic demo data, http://127.0.0.1:8080
```

Demo users (password `arogya-demo-2026`): `mehta` and `osei` (clinicians), `nurse`, `reception`, `manager`, `biller`, `admin`. **Never use demo mode with real data.**

A real site:

```sh
AROGYA_ADMIN_PASSWORD='at-least-12-characters' DATABASE_URL=postgres://… AROGYA_SECURE_COOKIES=1 npm start
node server/main.ts adduser jsmith nurse "Jo Smith" 'a-long-password'
AROGYA_BACKUP_PASSPHRASE='…' node server/main.ts backup site.arogya-backup
AROGYA_BACKUP_PASSPHRASE='…' node server/main.ts restore site.arogya-backup   # into an empty database only
```

Two-step secrets are sealed with an application key. It is created at `.data/secret.key` (mode 0600) on first run; set `AROGYA_KEY_FILE` or `AROGYA_KEY` (32 bytes, base64) to keep it elsewhere. Back the key up separately: without it, users must re-enrol two-step verification.

Put it behind TLS. Set the server's `TZ` to the clinic's time zone: sessions are wall-clock. Or use Docker: `AROGYA_ADMIN_PASSWORD=… docker compose up`.

Release bundles (`.tar.gz`, `.zip`) are on the [Releases](../../releases) page.

## Develop

```sh
npm test            # integration tests on in-memory Postgres
npm run e2e -- http://127.0.0.1:8080   # browser walk-through against a fresh demo server
npm run typecheck
npm run dev         # API with reload
npm run dev:web     # Vite UI with proxy to :8080
```

Layout: `server/` (Fastify API, FHIR store, rules), `web/` (React client), `data/` (illustrative drug knowledge), `test/`.

## Clean-room statement

Arogya is written from public documentation, published standards (HL7 FHIR R4, LOINC, ...) and published studies about what users need. No source code, database schema, screen design or text from Epic, Oracle Health/Cerner, ERPNext/Marley Health, OpenEMR, OpenMRS or any other product was copied, and no product was reverse-engineered. Comparisons are of *capabilities*, not implementations. Details: [docs/CLEAN_ROOM.md](docs/CLEAN_ROOM.md).

## Licence

AGPL-3.0-or-later. If you run a modified Arogya as a network service, you must offer its users the source.
