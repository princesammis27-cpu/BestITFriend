# Deploy notes — PHP + PostgreSQL

Same app as the Netlify/Supabase version, re-platformed: plain PHP (no
framework) talking to PostgreSQL directly over PDO, file uploads on local
disk, Google Sign-In verified without Supabase.

## Layout
```
public/index.html          the app (API_BASE="" — same origin as the API)
public/api/index.php        the whole backend (routes every /api/* request)
public/api/.htaccess         Apache rewrite: everything under api/ -> index.php
public/.htaccess            lets /api/ and real files (incl. /uploads/) through
public/uploads/             avatars/, uploads/, chat-media/ — must be writable
src/                       Db.php, Auth.php, Response.php, Google.php
schema.sql                  run once in PostgreSQL
composer.json               firebase/php-jwt, vlucas/phpdotenv
.env.example                copy to .env and fill in
```

## Requirements
PHP 8.0+, with `pdo_pgsql` and `curl` extensions, and Apache with
`mod_rewrite` (or translate the two `.htaccess` files to nginx — see below).
Composer, to install dependencies.

## 1. Database
Any PostgreSQL 13+ works — a managed one (Supabase's own Postgres, Neon,
Railway, RDS) or self-hosted.
```
psql "postgresql://user:pass@host:5432/dbname" -f schema.sql
```
Then create the least-privilege app role (statements are at the bottom of
`schema.sql`) and use that role's credentials in `.env`, not a superuser.

## 2. Install
```
cd php-backend
composer install
cp .env.example .env    # fill in DB_*, JWT_SECRET, GOOGLE_CLIENT_ID, APP_URL, MPESA_*
chmod -R 775 public/uploads
```
Generate `JWT_SECRET` with something like `openssl rand -base64 48`.

## 3. Web server
Point the document root at `public/`. Apache: the two `.htaccess` files
already do the work, as long as `AllowOverride All` is set for this vhost.

Nginx equivalent (put in the server block, `root` pointing at `public/`):
```nginx
location /api/ {
  try_files $uri /api/index.php$is_args$args;
}
location ~ \.php$ {
  fastcgi_pass unix:/run/php/php8.2-fpm.sock; # match your PHP-FPM socket
  fastcgi_index index.php;
  include fastcgi_params;
  fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
}
```
Also raise `upload_max_filesize` / `post_max_size` in `php.ini` (uploads
arrive as base64 JSON, so a 5 MB file needs a ~7 MB request) and restart
PHP-FPM/Apache after editing `.env`-dependent settings.

## 4. Google Sign-In
1. console.cloud.google.com → APIs & Services → Credentials → **OAuth
   client ID** (Web application). Add your site's exact origin (e.g.
   `https://yourdomain.com`) under **Authorized JavaScript origins** — no
   redirect URI needed, Google Identity Services uses a popup/prompt, not a
   redirect.
2. Put that client ID in `GOOGLE_CLIENT_ID` in `.env` **and** in
   `public/index.html`'s `const GOOGLE_CLIENT_ID = "..."` (search for it near
   the top of the second `<script>` block).

## 5. Make yourself admin
Sign up once through the app, then:
```sql
UPDATE users SET is_admin = true WHERE email = 'you@example.com';
```

## 6. M-Pesa
Fill in the `MPESA_*` vars from your Daraja app (sandbox first). Set
`MPESA_CALLBACK_URL` to `https://yourdomain.com/api/mpesa/callback` — Daraja
must be able to reach it, so this needs a public HTTPS domain (not
`localhost`).

## Smoke test
```
curl https://yourdomain.com/api/reviews        # expect []
curl -X POST https://yourdomain.com/api/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"username":"test","email":"test@example.com","password":"testpass123"}'
```

## How this differs from the Netlify/Supabase version
- **Auth**: still a JWT, but signed by this server (`JWT_SECRET`), not
  bridged from Supabase. Google Sign-In uses Google Identity Services
  directly — the frontend gets a signed ID token from Google, POSTs it to
  `/api/auth/google`, which verifies it against Google's `tokeninfo`
  endpoint and mints our own JWT. No Supabase project needed at all.
- **File storage**: uploads are written to `public/uploads/<bucket>/...` on
  local disk instead of a Supabase Storage bucket. Fine for one server; if
  you later scale to multiple app servers, point this at shared storage
  (NFS/S3-compatible mount) or swap the upload handler in
  `public/api/index.php` for an S3 client.
- **RLS**: not applicable — `index.php` connects as a single trusted
  database role and enforces access rules in PHP (the same `requireAuth`/
  `requireAdmin` checks the Node version had).

## Troubleshooting
- 500 on every request: check `error_log` (PHP) — almost always a missing
  `.env` value or `composer install` not run.
- "Database error": wrong `DB_*` values, or the app role lacks GRANTs (see
  bottom of `schema.sql`).
- Sign-up/login JSON errors in the browser console instead of a clean error:
  PHP is printing a warning before the JSON — check `display_errors` is off
  in production (`log_errors = On`, `display_errors = Off`).
- Google button does nothing: `GOOGLE_CLIENT_ID` mismatch between
  `index.html` and `.env`, or the origin isn't whitelisted in Google Cloud
  Console.
- Uploaded images 404: `public/uploads/<bucket>/` isn't writable, or
  `APP_URL` in `.env` doesn't match the real domain.
