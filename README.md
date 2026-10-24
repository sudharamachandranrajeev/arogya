# Arogya

Arogya (आरोग्य, "health") is an open-source, FHIR-native electronic health record. It is built to remove the daily waste that clinicians, clerks, managers and patients report in existing systems.

**Status: v0.1, pre-release.** It is a working foundation for outpatient and community care. It is **not** certified, has not had a clinical safety review, and must not hold real patient data until your organisation has done its own safety, security and governance assessment. See [SECURITY.md](SECURITY.md).

## What it does today

| Area | Features |
|---|---|
| **Registration** | Fuzzy patient search (name, ID, phone, date of birth), duplicate warning at registration, restricted-record flag |
| **Chart** | One-call chart summary: allergies, problems, medications, vitals, results, referrals, appointments, notes. Short notes with `.dot` phrase shortcuts. One-step vitals entry |
| **Prescribing** | Allergy, interaction, duplicate-therapy and maximum-daily-dose checks. Only *high-severity* alerts interrupt; they need a logged reason to override. Override rate is a KPI |
| **Results** | Numeric results are auto-flagged against their own reference range and critical limits. Results route to the orderer's inbox. Critical results sort first |
| **Inbox** | Shared work pools (results, messages, triage, scheduling) plus personal queues. **Acknowledge all normal results in one click**; abnormal results are never bulk-closed |
| **Referrals and waiting list** | Priority targets (editable), days-to-breach, breach-ordered worklist |
| **Scheduling** | Clinic sessions generate slots. Booking is race-safe (two receptionists cannot take one slot). A cancelled or missed appointment creates a *fill this slot* task with ranked waiting-list candidates |
| **No-show risk** | Transparent score with the reasons shown to the scheduler |
| **Dashboard** | Waiting list size, average and longest wait, breaches, DNA and cancellation rates, lost slots, inbox age, result turnaround, alert overrides |
| **Security** | Role-based access, scrypt passwords, lockout, session cookies (HttpOnly, SameSite=Strict), CSRF header, **hash-chained tamper-evident audit log**, **break-glass** access with a stated reason |
| **Interoperability** | FHIR R4 REST for 26 resource types: read, vread, create, update (with `If-Match`), delete, search, history, `CapabilityStatement`. NDJSON export |

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
```

Put it behind TLS. Set the server's `TZ` to the clinic's time zone: sessions are wall-clock. Or use Docker: `AROGYA_ADMIN_PASSWORD=… docker compose up`.

Release bundles (`.tar.gz`, `.zip`) are on the [Releases](../../releases) page.

## Develop

```sh
npm test            # 11 integration tests on in-memory Postgres
npm run typecheck
npm run dev         # API with reload
npm run dev:web     # Vite UI with proxy to :8080
```

Layout: `server/` (Fastify API, FHIR store, rules), `web/` (React client), `data/` (illustrative drug knowledge), `test/`.

## Clean-room statement

Arogya is written from public documentation, published standards (HL7 FHIR R4, LOINC, ...) and published studies about what users need. No source code, database schema, screen design or text from Epic, Oracle Health/Cerner, ERPNext/Marley Health, OpenEMR, OpenMRS or any other product was copied, and no product was reverse-engineered. Comparisons are of *capabilities*, not implementations. Details: [docs/CLEAN_ROOM.md](docs/CLEAN_ROOM.md).

## Licence

AGPL-3.0-or-later. If you run a modified Arogya as a network service, you must offer its users the source.
