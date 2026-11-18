# Smart Calendar Task Board (PH)

One app, two calendars:

| | 👤 **Personal** | 👥 **Shared** |
|---|---|---|
| Who sees it | Only you | You + the people involved |
| What it is | Your own sticky-note board per date | Tasks a supervisor/head **assigns** to staff |
| Who can add | Everyone | Supervisors and the Head only |

Switch with the two big buttons under the header (or press **P** / **S**). Your last choice is remembered.

## Roles
- **Head (admin)** – assigns tasks to Supervisors and Staff (never to themselves or any other Head, including the default `admin`), manages users, links staff to supervisors, exports/imports backups.
- **Supervisor (host)** – assigns tasks to *their own* staff, edits/closes/trashes them, sees progress per person.
- **Staff** – sees tasks assigned to them, taps **✔ Mark done** for their part. A staff member can report to several supervisors.

A task assigned to several people is complete when **everyone** has marked their part done (shown as `1/3 done`); a supervisor can also **Close** it for everyone.

## Features
Philippine holiday calendar · date boards with drag & drop (Now / Next / Later, Complete, Trash) · "coming up" list · filter shared tasks by person · 4 themes · password change · login lockout (5 tries → 15 min) · admin user manager · full backup/restore.

## Deploy (GitHub → Netlify)
1. Push this folder to a GitHub repo.
2. Netlify → **Add new site → Import from Git**. Settings come from `netlify.toml` (no build command, publish dir `public`).
3. Add the environment variable **`ADMIN_INITIAL_PASSWORD`** (8+ chars) under *Site configuration → Environment variables*, then deploy.
4. Open the site, log in as `admin` with that password.
5. **Users** page → add Supervisors, then Staff (tick who they report to). New/reset passwords are temporary; people must choose their own at first login.

> Must deploy from Git or the Netlify CLI (not drag-and-drop) so the function's dependency installs.

## Local dev
```
npm install
npm i -g netlify-cli
echo ADMIN_INITIAL_PASSWORD=choose-one-123 > .env
netlify dev
```

## Tests
```
npm test
```
Runs 32 checks against the real API with an in-memory stand-in for Netlify Blobs (no network, no extra dependencies).
See `IMPROVEMENTS.md` for the review, the logout fix, and what changed in v2.2.

## Upgrading from the earlier calendar-only version
Same storage name, so existing accounts and personal boards carry over. Old `user` accounts become **Staff**; everyone is logged out once (new cookie sessions). Existing admin passwords are unchanged (`ADMIN_INITIAL_PASSWORD` is only used when no users exist yet).

## Layout
```
public/                static site (index, login, users, app.js, style.css)
netlify/functions/api.mjs   API at /api/*  (Netlify Blobs storage)
```
Data keys in the `taskboard` blob store: `users`, `shared`, `board:<userId>` (includes a `rev` revision number), `sess:<token>` (includes the user's password version `pv`).
