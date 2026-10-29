# Running a real Arogya site

The README shows how to try Arogya with made-up patients. This page covers a real installation.

> [!WARNING]
> Arogya v0.5 is not certified and has not had a clinical safety review. Do not store real patient
> data until your organisation has done its own safety, security and governance assessment. Read
> [SECURITY.md](../SECURITY.md) first: it lists what is still missing.

## 1. Pick a database

- **Built-in (PGlite)**: no setup. Arogya keeps an embedded PostgreSQL in `.data/pg` inside the
  folder you start it from. Set `AROGYA_DATA` to put it somewhere else. Good for one small clinic
  on one machine.
- **PostgreSQL**: set `DATABASE_URL=postgres://user:password@host:5432/arogya`. Use this for
  anything bigger, and for managed encryption at rest.

## 2. Start it with a first administrator

```bash
AROGYA_ADMIN_PASSWORD='at-least-12-characters' AROGYA_SECURE_COOKIES=1 \
  DATABASE_URL=postgres://… node server/main.ts
```

`AROGYA_ADMIN_PASSWORD` creates the user `admin` the first time only, when the database has no
users. Then sign in as `admin` and add people under **Admin → Users**, or from the command line:

```bash
node server/main.ts adduser jsmith nurse "Jo Smith" 'a-long-password'
```

Roles: `clinician`, `nurse`, `reception`, `manager`, `biller`, `admin`. Administrators manage users
and settings but cannot open clinical records.

## 3. Settings that matter

| Setting | What it does |
| --- | --- |
| `PORT` (default `8080`) and `HOST` (default `127.0.0.1`) | Where Arogya listens. Keep it on `127.0.0.1` behind a TLS reverse proxy. |
| `AROGYA_SECURE_COOKIES=1` | Marks the sign-in cookie as HTTPS-only and sends HSTS. Turn on whenever you serve over TLS. |
| `TZ` | Set to the clinic's time zone. Clinic sessions and appointment times use the server's clock. |
| `AROGYA_KEY_FILE` or `AROGYA_KEY` | The application key that seals two-step secrets. By default it is created at `.data/secret.key` (mode 0600) on first run. `AROGYA_KEY` takes 32 bytes, base64. |
| `AROGYA_DATA` | Folder for the built-in database (default `.data/pg`). |

**Back up the key file separately from the database.** Without it, two-step verification cannot be
checked, and everyone must enrol again (`node server/main.ts reset-mfa <username>`).

## 4. Docker

`compose.yaml` runs PostgreSQL and Arogya together. From a clone of the repository:

```bash
AROGYA_ADMIN_PASSWORD='at-least-12-characters' docker compose up
```

Change the database password `change-me` in `compose.yaml` (it appears twice) before you use it for anything real.

## 5. Two-step verification

Each person sets it up under **My account → Two-step verification → Set up**, with any
authenticator app. An administrator can require it for chosen roles under
**Admin → Require two-step verification**. People in those roles must enrol at their next sign-in.

## 6. Appointment reminders

Under **Admin → Appointment reminders**, set **Hours before**, your **Gateway URL (https)**, clinic
name and phone, then tick **Send reminders** and **Save**. Arogya shows a signing secret once: copy
it into your gateway.

- Arogya POSTs `{id, channel, to, text}` as JSON with an `X-Arogya-Signature` header
  (HMAC-SHA256 of the body). A failed send is tried again on later runs, up to three attempts.
- Texts carry the date, time and clinic only. Restricted records, patients without a phone and
  patients who opted out are skipped, with the reason in the outbox.
- With **Patients can reply** ticked, the gateway POSTs `{messageId, inReplyTo, from, text}` to
  `/api/reminders/reply` with `X-Arogya-Timestamp` (Unix seconds) and `X-Arogya-Signature`
  (HMAC-SHA256 of `timestamp.body`). C confirms, X cancels and offers the slot to the waiting list,
  STOP ends reminders. Anything else goes to reception's inbox.

## 7. Backups, restore and checks

```bash
AROGYA_BACKUP_PASSPHRASE='…' node server/main.ts backup site.arogya-backup
AROGYA_BACKUP_PASSPHRASE='…' node server/main.ts restore site.arogya-backup   # into an empty database only
node server/main.ts check        # integrity report; exits 1 on a failure
```

Backups are encrypted (AES-256-GCM). An administrator with two-step on can also download one under
**Admin → Encrypted backup**. The integrity check also runs daily and shows on the Admin page.
`check` prints an audit head line: keep it somewhere outside the server, because a later head must
still contain it.

## 8. Before real patients

Work through the "Not yet done" list in [SECURITY.md](../SECURITY.md). In short: put the live
database on an encrypted disk, connect a maintained drug formulary (the bundled one is
illustrative), ship audit rows to append-only storage, and get a penetration test and a clinical
safety case.
