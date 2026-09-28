# Deploy notes — Netlify + Supabase

## Layout
```
public/index.html              the app (already wired to /api/*)
netlify/functions/api.js       the whole backend (Express in one function)
netlify.toml                   maps /api/* -> the function, same origin (no CORS, no API_BASE)
package.json                   function dependencies
schema.sql                     run once in Supabase
```

## 1. Supabase
1. Create a project.
2. **SQL Editor** -> paste `schema.sql` -> Run (safe to re-run).
3. **Storage** -> create three buckets: `avatars`, `uploads`, `chat-media` (set Public for simple URLs).
4. **Project Settings -> API**: copy `Project URL`, `service_role` key, and (Settings -> JWT) the **JWT Secret**.
5. **Authentication -> Providers -> Google**: enable it, add your Google OAuth client ID/secret.
   Add your Netlify URL under Authentication -> URL Configuration (Site URL + Redirect URLs).
6. Make yourself admin: `update users set is_admin = true where email = 'you@example.com';`
   (sign up once first so the row exists).

## 2. index.html
Put your Supabase **Project URL** and **anon** key in the existing `SUPABASE_URL` / `SUPABASE_ANON`
constants (used only for Google sign-in). Never put the service_role key in the HTML.
Leave `API_BASE` alone: empty means same origin, which is right on Netlify.

## 3. Netlify
1. Push this folder to GitHub, then Netlify -> Add new site -> Import.
   Publish directory `public`, functions `netlify/functions` (already in netlify.toml).
2. Site settings -> Environment variables:

| Variable | Value |
|---|---|
| SUPABASE_URL | Project URL |
| SUPABASE_SERVICE_ROLE_KEY | service_role key (secret) |
| SUPABASE_JWT_SECRET | Supabase JWT secret |
| MPESA_ENV | `sandbox` or `production` |
| MPESA_CONSUMER_KEY / MPESA_CONSUMER_SECRET | Daraja app credentials |
| MPESA_SHORTCODE / MPESA_PASSKEY | Daraja shortcode / passkey |
| MPESA_CALLBACK_URL | `https://YOUR-SITE.netlify.app/api/mpesa/callback` |

3. Deploy. Test: open `https://YOUR-SITE.netlify.app/api/reviews` -> should return `[]`.
4. Local dev: `npm i -g netlify-cli && npm install && netlify dev` (put the vars in a `.env` file).

## How auth works
- Email/password: `/api/auth/signup|login` hash with bcrypt server-side and return a JWT signed with
  `SUPABASE_JWT_SECRET`.
- Google: Supabase Auth issues its own JWT; the app sends it as the Bearer token. Same secret, so the
  function verifies both identically (by the `email` claim), then creates/updates the `users` row.
- Premium status is never trusted from the browser; it is only kept if a successful M-Pesa premium
  transaction for that phone exists.

## Troubleshooting sign-up
- "Cannot reach the server": the function isn't deployed, or you opened index.html from your disk (file://). Use the Netlify URL or `netlify dev`.
- "endpoint not found": `netlify.toml` redirect missing from the deploy.
- 500 / "Invalid API key": wrong `SUPABASE_URL` or service_role key.
- "duplicate key ... username": that username is taken.
- Google button fails: Google provider not enabled, or redirect URL not whitelisted in Supabase.
