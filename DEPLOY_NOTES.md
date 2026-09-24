# PrincesammisNewsFeed — Premium Membership Update

## What changed

1. **Premium pricing** → Daily KSh 200 / Weekly KSh 500 / Monthly KSh 1000.
2. **Downloads are now locked behind a real, backend-verified Daraja payment.**
   The old "type in your M-Pesa confirmation code" box is gone — it never actually
   checked anything. Now: pick a plan → enter your phone → STK push is sent → you enter
   your M-Pesa PIN → the backend receives Safaricom's callback → only then does the app
   unlock. The frontend re-checks a live backend endpoint (`/api/mpesa/premium-status`)
   before every download, so a tampered browser can't fake premium access.
3. **The price is enforced by the server, not the browser.** Even if someone edits the
   page's JavaScript to send a fake amount, `server.js` always looks up the real price for
   the plan and ignores whatever the client sent.
4. **Admin photo** — the tutor card now shows your uploaded photo as "Prince Sammis · Admin
   & Technical Assistance", linked to WhatsApp `0790567080`.
5. **Bug fixes found during review**: the long-press context menu (delete/share on chat
   messages) had two conflicting, duplicate implementations left over from earlier edits —
   one of them was silently broken (menu wouldn't close properly, delete didn't find the
   right message). Consolidated to one working version. Also fixed a login bug where an
   action you were doing before being asked to log in wasn't resumed afterward.
6. **Responsive** — checked at both a phone width (390px) and a desktop width (1440px);
   the paywall, pricing cards, and profile page all render correctly at both.

**Known pre-existing item I did not touch:** there's a second, unused "DM" chat page
(`initDMs`/`pgDMs`) left over from an earlier version of the file. It's never linked from
any button, so it doesn't affect anything — just flagging it as dead code for a future
cleanup, since it was outside the scope of this update.

## Deploying the backend (`server.js`)

This is an Express app meant for Vercel (see `api/index.js` and `api/[...path].js`), or you
can run it anywhere Node runs.

**Environment variables to set** (Vercel dashboard → Settings → Environment Variables, or a
`.env` file for local testing):

```
DATABASE_URL=postgres://...              # your Postgres connection string
MPESA_CONSUMER_KEY=...                   # from your Daraja app
MPESA_CONSUMER_SECRET=...                # from your Daraja app
MPESA_SHORTCODE=...                      # your Paybill/Till number
MPESA_PASSKEY=...                        # from Daraja
MPESA_CALLBACK_URL=https://your-backend.vercel.app/api/mpesa/callback
MPESA_ENV=sandbox                        # change to "production" when Safaricom approves go-live
```

**Database setup** — run `schema.sql` once against your Postgres database:

```
psql "$DATABASE_URL" -f schema.sql
```

It's safe to re-run — every statement is idempotent, so running it again (or on a database
that already has the table) won't lose data or throw errors.

## Wiring the frontend to your backend

Open `index.html`, find this line near the top of the main `<script>`:

```js
var MPESA_API_BASE = window.MPESA_API_BASE || "https://YOUR-BACKEND-DOMAIN.example";
```

Replace `https://YOUR-BACKEND-DOMAIN.example` with your deployed backend's real URL (e.g.
`https://princesammis-daraja-backend.vercel.app`), then re-upload `index.html`.

## What I tested before handing this off

I ran the full flow against a real local Postgres database and a mocked Daraja API in real
Chromium (not just reading the code):

- A tampered client trying to pay KSh 1 for a plan → server charged the correct real price.
- A made-up plan ID → rejected.
- Missing/invalid phone numbers → rejected on both endpoints.
- A cancelled/failed payment → phone correctly left with **no** premium access.
- A real successful payment → premium activated with the correct expiry, download
  auto-resumed, and a second download attempt skipped the paywall entirely (no repeat
  charge).
- No JavaScript console errors on load, on either a 390px or 1440px viewport.

I was not able to test against the real Safaricom Daraja sandbox itself (that needs your
actual Consumer Key/Secret, which you'll add once deployed) — everything above was verified
against a faithful mock of Daraja's real request/response shape and callback behavior.
