# PrincesammisNewsFeed Enterprises — Daraja STK Push

This package adapts the uploaded `index (1).html` so downloads use an M-Pesa STK Push instead of asking the customer to type an M-Pesa confirmation code.

## What changed
- The existing download button now asks for the customer's Kenyan M-Pesa number.
- The browser calls `POST /api/mpesa/stk-push`.
- The backend obtains a Daraja OAuth token and sends the STK Push.
- Safaricom calls `/api/mpesa/callback` after the customer completes/cancels payment.
- The browser polls `/api/mpesa/status/:checkoutRequestId`.
- The download happens only after the backend records a successful callback.
- Daraja secrets stay on the backend, not in the HTML.

Safaricom describes Daraja as the platform connecting M-PESA APIs to web/mobile applications. See the official portal: https://developer.safaricom.co.ke/

## Important sandbox limitation in your current app
The uploaded HTML does **not** currently store a numeric price for each product. The demo therefore falls back to **KSh 1** for a product when no price is found. Before production, move product prices to PostgreSQL/server-side data and do not trust an amount supplied by the browser.

## Setup
1. Install Node.js 20+ and PostgreSQL.
2. Create a PostgreSQL database, e.g. `princesammis`.
3. In `backend/`, run `npm install`.
4. Copy `.env.example` to `.env` and fill in your Daraja sandbox Consumer Key/Secret, sandbox shortcode/passkey, database URL, and a public HTTPS callback URL.
5. Run `schema.sql` against PostgreSQL.
6. Start with `npm start`.
7. Change `MPESA_API_BASE` near the download code in `index.html` from the placeholder to the public URL of this backend.
8. Host `index.html` from your website/GitHub Pages/etc. The backend must be reachable over HTTPS for the Daraja callback.

## Security
- Never commit `.env` to GitHub.
- Never put Consumer Secret or Passkey in `index.html`.
- For production, server-side product pricing should be authoritative.
- Keep payment records in PostgreSQL and grant downloads only after verified callback success.

## Membership
The existing Premium membership flow is still manual in this version. The product-download flow is the one converted to Daraja STK Push. Membership can use the same backend pattern after the download flow is tested.
