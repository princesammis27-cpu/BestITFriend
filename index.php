<?php
// public/api/index.php — the whole backend, mirroring the Node/Netlify
// version's routes but talking to PostgreSQL directly via PDO and storing
// uploads on local disk instead of Supabase Storage.

require_once __DIR__ . '/../../vendor/autoload.php';
require_once __DIR__ . '/../../src/Db.php';
require_once __DIR__ . '/../../src/Response.php';
require_once __DIR__ . '/../../src/Auth.php';
require_once __DIR__ . '/../../src/Google.php';

if (file_exists(__DIR__ . '/../../.env') && class_exists('Dotenv\Dotenv')) {
    \Dotenv\Dotenv::createImmutable(__DIR__ . '/../../')->safeLoad();
}

// ── CORS (harmless if frontend and API share one origin; needed if not) ──
$corsOrigin = getenv('CORS_ORIGIN') ?: '*';
header('Access-Control-Allow-Origin: ' . $corsOrigin);
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$method = $_SERVER['REQUEST_METHOD'];
$uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$pos = strpos($uri, '/api');
$path = $pos !== false ? substr($uri, $pos + 4) : $uri;
if ($path === '' || $path === false) $path = '/';
$path = rtrim($path, '/');
if ($path === '') $path = '/';

function read_json_body(): array
{
    $raw = file_get_contents('php://input');
    if (!$raw) return [];
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function public_user(?array $row): ?array
{
    if (!$row) return null;
    unset($row['password_hash']);
    return $row;
}

function to_bool($v): bool
{
    return $v === true || $v === 't' || $v === '1' || $v === 1;
}

$pdo = Db::get();
$body = in_array($method, ['POST', 'PUT', 'PATCH'], true) ? read_json_body() : [];

try {

    // ── AUTH ────────────────────────────────────────────────────────────
    if ($method === 'POST' && $path === '/auth/signup') {
        $username = trim($body['username'] ?? '');
        $email    = trim($body['email'] ?? '');
        $password = (string)($body['password'] ?? '');
        if (!$username || !$email || strlen($password) < 8) {
            Response::error('Missing or invalid username/email/password', 400);
        }
        $stmt = $pdo->prepare('SELECT 1 FROM users WHERE email = :email');
        $stmt->execute(['email' => $email]);
        if ($stmt->fetch()) Response::error('Email already registered', 409);

        $hash = password_hash($password, PASSWORD_BCRYPT);
        $stmt = $pdo->prepare('INSERT INTO users (email, username, password_hash) VALUES (:email, :username, :hash) RETURNING *');
        try {
            $stmt->execute(['email' => $email, 'username' => $username, 'hash' => $hash]);
        } catch (PDOException $e) {
            Response::error(strpos($e->getMessage(), 'username') !== false ? 'Username already taken' : 'Signup failed', 400);
        }
        $user = $stmt->fetch();
        Response::json(['token' => Auth::sign($email), 'user' => public_user($user)]);
    }

    if ($method === 'POST' && $path === '/auth/login') {
        $identifier = trim($body['identifier'] ?? '');
        $password   = (string)($body['password'] ?? '');
        if (!$identifier || !$password) Response::error('Missing credentials', 400);

        $stmt = $pdo->prepare('SELECT * FROM users WHERE email = :i OR username = :i LIMIT 1');
        $stmt->execute(['i' => $identifier]);
        $user = $stmt->fetch();
        if (!$user || !$user['password_hash'] || !password_verify($password, $user['password_hash'])) {
            Response::error('Wrong email/username or password', 401);
        }
        Response::json(['token' => Auth::sign($user['email']), 'user' => public_user($user)]);
    }

    if ($method === 'POST' && $path === '/auth/google') {
        $idToken = $body['id_token'] ?? '';
        if (!$idToken) Response::error('id_token is required', 400);
        $claims = Google::verifyIdToken($idToken);
        if (!$claims) Response::error('Invalid Google token', 401);

        $email = $claims['email'];
        $name  = $claims['name'] ?? explode('@', $email)[0];
        $stmt = $pdo->prepare('SELECT * FROM users WHERE email = :email');
        $stmt->execute(['email' => $email]);
        $user = $stmt->fetch();
        if (!$user) {
            $stmt = $pdo->prepare('INSERT INTO users (email, username) VALUES (:email, :username) RETURNING *');
            try {
                $stmt->execute(['email' => $email, 'username' => $name]);
            } catch (PDOException $e) {
                // username taken — fall back to a unique-ish one
                $stmt = $pdo->prepare('INSERT INTO users (email, username) VALUES (:email, :username) RETURNING *');
                $stmt->execute(['email' => $email, 'username' => $name . '_' . substr(md5($email), 0, 4)]);
            }
            $user = $stmt->fetch();
        }
        Response::json(['token' => Auth::sign($email), 'user' => public_user($user)]);
    }

    // ── UPLOADS (local disk: public/uploads/<bucket>/...) ─────────────────
    if ($method === 'POST' && $path === '/uploads') {
        $me = Auth::requireAuth($pdo);
        $bucket = $body['bucket'] ?? '';
        $filename = $body['filename'] ?? 'file';
        $dataUrl = $body['dataUrl'] ?? '';
        $allowed = ['avatars', 'uploads', 'chat-media'];
        if (!in_array($bucket, $allowed, true)) Response::error('Unknown bucket', 400);
        if (!preg_match('#^data:(.+?);base64,(.+)$#s', $dataUrl, $m)) {
            Response::error('dataUrl must be a base64 data: URL', 400);
        }
        $bytes = base64_decode($m[2], true);
        if ($bytes === false) Response::error('Invalid base64 payload', 400);

        $safeName = preg_replace('#[^a-zA-Z0-9._-]#', '_', $filename) ?: 'file';
        $safeEmail = preg_replace('#[^a-zA-Z0-9._-]#', '_', $me['email']);
        $rel = $safeEmail . '/' . time() . '_' . uniqid() . '_' . $safeName;
        $dir = __DIR__ . '/../uploads/' . $bucket . '/' . $safeEmail;
        if (!is_dir($dir) && !mkdir($dir, 0755, true) && !is_dir($dir)) {
            Response::error('Could not create upload directory', 500);
        }
        $fullPath = __DIR__ . '/../uploads/' . $bucket . '/' . $rel;
        if (file_put_contents($fullPath, $bytes) === false) {
            Response::error('Could not save file', 500);
        }
        $appUrl = rtrim(getenv('APP_URL') ?: '', '/');
        $url = $appUrl . '/uploads/' . $bucket . '/' . $rel;
        Response::json(['path' => $rel, 'url' => $url]);
    }

    // ── USERS ───────────────────────────────────────────────────────────
    if ($method === 'GET' && $path === '/users') {
        Auth::requireAuth($pdo);
        $stmt = $pdo->query('SELECT * FROM users ORDER BY username');
        Response::json(array_map('public_user', $stmt->fetchAll()));
    }

    if ($method === 'GET' && preg_match('#^/users/([^/]+)$#', $path, $m)) {
        $email = urldecode($m[1]);
        $stmt = $pdo->prepare('SELECT * FROM users WHERE email = :email');
        $stmt->execute(['email' => $email]);
        $user = $stmt->fetch();
        if (!$user) Response::error('Not found', 404);
        Response::json(public_user($user));
    }

    if ($method === 'PUT' && preg_match('#^/users/([^/]+)$#', $path, $m)) {
        $email = urldecode($m[1]);
        $tokenEmail = Auth::tokenEmail();
        if (!$tokenEmail) Response::error('Not authenticated', 401);
        if ($tokenEmail !== $email) Response::error('Not allowed', 403);

        $stmt = $pdo->prepare('SELECT * FROM users WHERE email = :email');
        $stmt->execute(['email' => $email]);
        $existing = $stmt->fetch();

        $plan = $existing['premium_plan'] ?? null;
        $phone = $existing['premium_phone'] ?? null;
        $exp = $existing['premium_expires_at'] ?? null;
        if (!empty($body['premium_phone'])) {
            $tx = $pdo->prepare("SELECT * FROM mpesa_transactions WHERE phone = :phone AND kind = 'premium' AND status = 'success' ORDER BY expires_at DESC LIMIT 1");
            $tx->execute(['phone' => $body['premium_phone']]);
            $t = $tx->fetch();
            if ($t && $t['expires_at'] && strtotime($t['expires_at']) > time()) {
                $plan = $t['plan']; $phone = $body['premium_phone']; $exp = $t['expires_at'];
            }
        }
        $username = $body['username'] ?? ($existing['username'] ?? explode('@', $email)[0]);
        $avatar = array_key_exists('avatar_path', $body) ? $body['avatar_path'] : ($existing['avatar_path'] ?? null);

        $sql = 'INSERT INTO users (email, username, avatar_path, premium_plan, premium_phone, premium_expires_at, updated_at)
                VALUES (:email, :username, :avatar, :plan, :phone, :exp, NOW())
                ON CONFLICT (email) DO UPDATE SET
                  username = EXCLUDED.username, avatar_path = EXCLUDED.avatar_path,
                  premium_plan = EXCLUDED.premium_plan, premium_phone = EXCLUDED.premium_phone,
                  premium_expires_at = EXCLUDED.premium_expires_at, updated_at = NOW()
                RETURNING *';
        $stmt = $pdo->prepare($sql);
        $stmt->execute(['email' => $email, 'username' => $username, 'avatar' => $avatar, 'plan' => $plan, 'phone' => $phone, 'exp' => $exp]);
        Response::json(public_user($stmt->fetch()));
    }

    if ($method === 'PATCH' && preg_match('#^/users/([^/]+)/password$#', $path, $m)) {
        $me = Auth::requireAuth($pdo);
        $email = urldecode($m[1]);
        if ($me['email'] !== $email && !to_bool($me['is_admin'])) Response::error('Not allowed', 403);
        $password = (string)($body['password'] ?? '');
        if (strlen($password) < 8) Response::error('Password must be at least 8 characters', 400);
        $hash = password_hash($password, PASSWORD_BCRYPT);
        $stmt = $pdo->prepare('UPDATE users SET password_hash = :hash, updated_at = NOW() WHERE email = :email');
        $stmt->execute(['hash' => $hash, 'email' => $email]);
        Response::json(['ok' => true]);
    }

    // ── FILES (files + trash share one table; deleted_at is the switch) ──
    if ($method === 'GET' && $path === '/files') {
        $sql = 'SELECT * FROM files WHERE 1=1';
        $params = [];
        if (($_GET['deleted'] ?? '') === 'true') $sql .= ' AND deleted_at IS NOT NULL';
        elseif (($_GET['deleted'] ?? '') === 'false') $sql .= ' AND deleted_at IS NULL';
        if (!empty($_GET['category'])) { $sql .= ' AND category = :cat'; $params['cat'] = $_GET['category']; }
        if (!empty($_GET['subcategory'])) { $sql .= ' AND subcategory = :sub'; $params['sub'] = $_GET['subcategory']; }
        $sql .= ' ORDER BY created_at DESC';
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        Response::json($stmt->fetchAll());
    }

    if ($method === 'GET' && preg_match('#^/files/([^/]+)$#', $path, $m)) {
        $stmt = $pdo->prepare('SELECT * FROM files WHERE id = :id');
        $stmt->execute(['id' => $m[1]]);
        $row = $stmt->fetch();
        if (!$row) Response::error('Not found', 404);
        Response::json($row);
    }

    if ($method === 'PUT' && preg_match('#^/files/([^/]+)$#', $path, $m)) {
        $me = Auth::requireAuth($pdo);
        Auth::requireAdmin($me);
        $id = $m[1];
        $sql = 'INSERT INTO files (id, name, caption, category, subcategory, storage_path, size, mime_type, uploaded_by, deleted_at)
                VALUES (:id, :name, :caption, :category, :sub, :storage, :size, :mime, :by, :deleted)
                ON CONFLICT (id) DO UPDATE SET
                  name = EXCLUDED.name, caption = EXCLUDED.caption, category = EXCLUDED.category,
                  subcategory = EXCLUDED.subcategory, storage_path = EXCLUDED.storage_path,
                  size = EXCLUDED.size, mime_type = EXCLUDED.mime_type, deleted_at = EXCLUDED.deleted_at
                RETURNING *';
        $stmt = $pdo->prepare($sql);
        $stmt->execute([
            'id' => $id,
            'name' => $body['name'] ?? '',
            'caption' => $body['caption'] ?? '',
            'category' => $body['category'] ?? null,
            'sub' => $body['subcategory'] ?? '',
            'storage' => $body['storage_path'] ?? '',
            'size' => $body['size'] ?? null,
            'mime' => $body['type'] ?? null,
            'by' => $body['uploaded_by'] ?? $me['email'],
            'deleted' => !empty($body['deleted']) ? date('c') : null,
        ]);
        Response::json($stmt->fetch());
    }

    if ($method === 'PATCH' && preg_match('#^/files/([^/]+)$#', $path, $m)) {
        $me = Auth::requireAuth($pdo);
        Auth::requireAdmin($me);
        if (!array_key_exists('deleted', $body)) Response::error('Nothing to update', 400);
        $stmt = $pdo->prepare('UPDATE files SET deleted_at = :d WHERE id = :id RETURNING *');
        $stmt->execute(['d' => $body['deleted'] ? date('c') : null, 'id' => $m[1]]);
        $row = $stmt->fetch();
        if (!$row) Response::error('Not found', 404);
        Response::json($row);
    }

    if ($method === 'DELETE' && preg_match('#^/files/([^/]+)$#', $path, $m)) {
        $me = Auth::requireAuth($pdo);
        Auth::requireAdmin($me);
        $pdo->prepare('DELETE FROM files WHERE id = :id')->execute(['id' => $m[1]]);
        Response::noContent();
    }

    // ── CHAT ────────────────────────────────────────────────────────────
    if ($method === 'GET' && $path === '/chat-messages') {
        $stmt = $pdo->query('SELECT * FROM chat_messages ORDER BY created_at');
        Response::json($stmt->fetchAll());
    }

    if ($method === 'PUT' && preg_match('#^/chat-messages/([^/]+)$#', $path, $m)) {
        $me = Auth::requireAuth($pdo);
        $sql = 'INSERT INTO chat_messages (id, sender_email, sender_username, text, image_path, image_paths, reply_label, likes)
                VALUES (:id, :email, :username, :text, :img, :imgs, :reply, :likes)
                ON CONFLICT (id) DO UPDATE SET
                  text = EXCLUDED.text, image_path = EXCLUDED.image_path, image_paths = EXCLUDED.image_paths,
                  reply_label = EXCLUDED.reply_label, likes = EXCLUDED.likes
                RETURNING *';
        $stmt = $pdo->prepare($sql);
        $stmt->execute([
            'id' => $m[1],
            'email' => $me['email'],
            'username' => $body['sender_username'] ?? $me['username'],
            'text' => $body['text'] ?? null,
            'img' => $body['image_path'] ?? null,
            'imgs' => !empty($body['image_paths']) ? json_encode($body['image_paths']) : null,
            'reply' => $body['reply_label'] ?? null,
            'likes' => json_encode($body['likes'] ?? []),
        ]);
        Response::json($stmt->fetch());
    }

    if ($method === 'DELETE' && preg_match('#^/chat-messages/([^/]+)$#', $path, $m)) {
        $me = Auth::requireAuth($pdo);
        $stmt = $pdo->prepare('SELECT sender_email FROM chat_messages WHERE id = :id');
        $stmt->execute(['id' => $m[1]]);
        $row = $stmt->fetch();
        if ($row && $row['sender_email'] !== $me['email'] && !to_bool($me['is_admin'])) Response::error('Not allowed', 403);
        $pdo->prepare('DELETE FROM chat_messages WHERE id = :id')->execute(['id' => $m[1]]);
        Response::noContent();
    }

    // ── DIRECT MESSAGES ─────────────────────────────────────────────────
    if ($method === 'GET' && $path === '/dm-messages') {
        $me = Auth::requireAuth($pdo);
        $sql = 'SELECT * FROM dm_messages WHERE (from_email = :me OR to_email = :me)';
        $params = ['me' => $me['email']];
        if (!empty($_GET['from'])) { $sql .= ' AND from_email = :from'; $params['from'] = $_GET['from']; }
        if (!empty($_GET['to'])) { $sql .= ' AND to_email = :to'; $params['to'] = $_GET['to']; }
        $sql .= ' ORDER BY created_at';
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        Response::json($stmt->fetchAll());
    }

    if ($method === 'PUT' && preg_match('#^/dm-messages/([^/]+)$#', $path, $m)) {
        $me = Auth::requireAuth($pdo);
        if (!empty($body['from_email']) && $body['from_email'] !== $me['email']) {
            Response::error('from_email must be you', 403);
        }
        $sql = 'INSERT INTO dm_messages (id, from_email, to_email, text, image_path, image_paths, read)
                VALUES (:id, :from, :to, :text, :img, :imgs, :read)
                ON CONFLICT (id) DO UPDATE SET
                  text = EXCLUDED.text, image_path = EXCLUDED.image_path, image_paths = EXCLUDED.image_paths,
                  read = EXCLUDED.read
                RETURNING *';
        $stmt = $pdo->prepare($sql);
        $stmt->execute([
            'id' => $m[1],
            'from' => $me['email'],
            'to' => $body['to_email'] ?? null,
            'text' => $body['text'] ?? null,
            'img' => $body['image_path'] ?? null,
            'imgs' => !empty($body['image_paths']) ? json_encode($body['image_paths']) : null,
            'read' => !empty($body['read']) ? 't' : 'f',
        ]);
        Response::json($stmt->fetch());
    }

    if ($method === 'DELETE' && preg_match('#^/dm-messages/([^/]+)$#', $path, $m)) {
        $me = Auth::requireAuth($pdo);
        $stmt = $pdo->prepare('SELECT from_email FROM dm_messages WHERE id = :id');
        $stmt->execute(['id' => $m[1]]);
        $row = $stmt->fetch();
        if ($row && $row['from_email'] !== $me['email'] && !to_bool($me['is_admin'])) Response::error('Not allowed', 403);
        $pdo->prepare('DELETE FROM dm_messages WHERE id = :id')->execute(['id' => $m[1]]);
        Response::noContent();
    }

    // ── REVIEWS ─────────────────────────────────────────────────────────
    if ($method === 'GET' && $path === '/reviews') {
        $stmt = $pdo->query('SELECT * FROM reviews ORDER BY created_at DESC');
        Response::json($stmt->fetchAll());
    }

    if ($method === 'PUT' && preg_match('#^/reviews/([^/]+)$#', $path, $m)) {
        $me = Auth::requireAuth($pdo);
        $stars = (int)($body['stars'] ?? 0);
        if ($stars < 1 || $stars > 5) Response::error('stars must be 1-5', 400);
        $sql = 'INSERT INTO reviews (id, user_email, username, stars, text)
                VALUES (:id, :email, :username, :stars, :text)
                ON CONFLICT (id) DO UPDATE SET stars = EXCLUDED.stars, text = EXCLUDED.text
                RETURNING *';
        $stmt = $pdo->prepare($sql);
        $stmt->execute([
            'id' => $m[1], 'email' => $me['email'],
            'username' => $body['username'] ?? $me['username'],
            'stars' => $stars, 'text' => $body['text'] ?? null,
        ]);
        Response::json($stmt->fetch());
    }

    if ($method === 'DELETE' && preg_match('#^/reviews/([^/]+)$#', $path, $m)) {
        $me = Auth::requireAuth($pdo);
        $stmt = $pdo->prepare('SELECT user_email FROM reviews WHERE id = :id');
        $stmt->execute(['id' => $m[1]]);
        $row = $stmt->fetch();
        if ($row && $row['user_email'] !== $me['email'] && !to_bool($me['is_admin'])) Response::error('Not allowed', 403);
        $pdo->prepare('DELETE FROM reviews WHERE id = :id')->execute(['id' => $m[1]]);
        Response::noContent();
    }

    // ── VISITS (presence) ───────────────────────────────────────────────
    if ($method === 'GET' && $path === '/visits') {
        $me = Auth::requireAuth($pdo);
        Auth::requireAdmin($me);
        $sql = 'SELECT v.user_email, v.last_page, v.last_seen_at, u.username, u.avatar_path AS avatar
                FROM visits v LEFT JOIN users u ON u.email = v.user_email
                ORDER BY v.last_seen_at DESC';
        Response::json($pdo->query($sql)->fetchAll());
    }

    if ($method === 'PUT' && preg_match('#^/visits/([^/]+)$#', $path, $m)) {
        $me = Auth::requireAuth($pdo);
        $email = urldecode($m[1]);
        if ($me['email'] !== $email) Response::error('Not allowed', 403);
        $sql = 'INSERT INTO visits (user_email, last_page, last_seen_at) VALUES (:email, :page, :seen)
                ON CONFLICT (user_email) DO UPDATE SET last_page = EXCLUDED.last_page, last_seen_at = EXCLUDED.last_seen_at';
        $stmt = $pdo->prepare($sql);
        $stmt->execute([
            'email' => $email,
            'page' => $body['last_page'] ?? '',
            'seen' => $body['last_seen_at'] ?? date('c'),
        ]);
        Response::json(['ok' => true]);
    }

    // ── M-PESA (Daraja STK push) ────────────────────────────────────────
    if ($method === 'POST' && $path === '/mpesa/stk-push') {
        $productId = $body['productId'] ?? null;
        $phone = $body['phone'] ?? null;
        $amount = $body['amount'] ?? null;
        $kind = $body['kind'] ?? 'file';
        $plan = $body['plan'] ?? null;
        if (!$phone || !$amount) Response::error('phone and amount are required', 400);

        $env = getenv('MPESA_ENV') ?: 'sandbox';
        $base = $env === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
        $consumerKey = getenv('MPESA_CONSUMER_KEY');
        $consumerSecret = getenv('MPESA_CONSUMER_SECRET');
        $shortcode = getenv('MPESA_SHORTCODE');
        $passkey = getenv('MPESA_PASSKEY');
        $callbackUrl = getenv('MPESA_CALLBACK_URL');

        $ch = curl_init("$base/oauth/v1/generate?grant_type=client_credentials");
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_USERPWD => "$consumerKey:$consumerSecret",
        ]);
        $tokenResp = json_decode(curl_exec($ch), true);
        curl_close($ch);
        $accessToken = $tokenResp['access_token'] ?? null;
        if (!$accessToken) Response::error('Could not authenticate with M-Pesa', 502);

        $timestamp = date('YmdHis');
        $password = base64_encode($shortcode . $passkey . $timestamp);

        $payload = json_encode([
            'BusinessShortCode' => $shortcode,
            'Password' => $password,
            'Timestamp' => $timestamp,
            'TransactionType' => 'CustomerPayBillOnline',
            'Amount' => $amount,
            'PartyA' => $phone,
            'PartyB' => $shortcode,
            'PhoneNumber' => $phone,
            'CallBackURL' => $callbackUrl,
            'AccountReference' => $productId ?: 'PNFOrder',
            'TransactionDesc' => 'BestITFriend purchase',
        ]);
        $ch = curl_init("$base/mpesa/stkpush/v1/processrequest");
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $payload,
            CURLOPT_HTTPHEADER => ["Authorization: Bearer $accessToken", 'Content-Type: application/json'],
        ]);
        $stkResp = json_decode(curl_exec($ch), true);
        curl_close($ch);

        $checkoutId = $stkResp['CheckoutRequestID'] ?? null;
        if (!$checkoutId) Response::error($stkResp['errorMessage'] ?? 'STK push failed', 400);

        $days = ['day' => 1, 'week' => 7, 'month' => 30];
        $expiresAt = $plan ? date('c', time() + ($days[$plan] ?? 0) * 86400) : null;

        $stmt = $pdo->prepare('INSERT INTO mpesa_transactions
            (product_id, phone, amount, merchant_request_id, checkout_request_id, kind, plan, expires_at)
            VALUES (:pid, :phone, :amount, :mrid, :crid, :kind, :plan, :exp)');
        $stmt->execute([
            'pid' => $productId, 'phone' => $phone, 'amount' => $amount,
            'mrid' => $stkResp['MerchantRequestID'] ?? null, 'crid' => $checkoutId,
            'kind' => $kind, 'plan' => $plan, 'exp' => $expiresAt,
        ]);
        Response::json(['checkoutRequestId' => $checkoutId]);
    }

    if ($method === 'POST' && $path === '/mpesa/callback') {
        $stk = $body['Body']['stkCallback'] ?? null;
        if (!$stk) Response::json(['ResultCode' => 0, 'ResultDesc' => 'Ignored']);
        $items = $stk['CallbackMetadata']['Item'] ?? [];
        $get = function ($name) use ($items) {
            foreach ($items as $it) if (($it['Name'] ?? '') === $name) return $it['Value'] ?? null;
            return null;
        };
        $stmt = $pdo->prepare('UPDATE mpesa_transactions SET
            status = :status, result_code = :rcode, result_desc = :rdesc,
            mpesa_receipt = :receipt, transaction_date = :txdate, raw_callback = :raw, updated_at = NOW()
            WHERE checkout_request_id = :crid');
        $stmt->execute([
            'status' => ($stk['ResultCode'] ?? 1) === 0 ? 'success' : 'failed',
            'rcode' => $stk['ResultCode'] ?? null,
            'rdesc' => $stk['ResultDesc'] ?? null,
            'receipt' => $get('MpesaReceiptNumber'),
            'txdate' => $get('TransactionDate') !== null ? (string)$get('TransactionDate') : null,
            'raw' => json_encode($body),
            'crid' => $stk['CheckoutRequestID'] ?? null,
        ]);
        Response::json(['ResultCode' => 0, 'ResultDesc' => 'Accepted']);
    }

    if ($method === 'GET' && preg_match('#^/mpesa/status/([^/]+)$#', $path, $m)) {
        $stmt = $pdo->prepare('SELECT * FROM mpesa_transactions WHERE checkout_request_id = :id');
        $stmt->execute(['id' => $m[1]]);
        $row = $stmt->fetch();
        if (!$row) Response::error('Not found', 404);
        Response::json(['status' => $row['status'], 'receipt' => $row['mpesa_receipt'], 'plan' => $row['plan'], 'expiresAt' => $row['expires_at']]);
    }

    if ($method === 'GET' && $path === '/mpesa/premium-status') {
        $phone = $_GET['phone'] ?? null;
        if (!$phone) Response::error('phone is required', 400);
        $stmt = $pdo->prepare("SELECT * FROM mpesa_transactions WHERE phone = :phone AND kind = 'premium' AND status = 'success' ORDER BY expires_at DESC LIMIT 1");
        $stmt->execute(['phone' => $phone]);
        $row = $stmt->fetch();
        $active = $row && $row['expires_at'] && strtotime($row['expires_at']) > time();
        Response::json(['active' => (bool)$active, 'plan' => $row['plan'] ?? null, 'expiresAt' => $row['expires_at'] ?? null]);
    }

    Response::error('Unknown endpoint', 404);

} catch (PDOException $e) {
    error_log('DB error: ' . $e->getMessage());
    Response::error('Database error', 500);
} catch (\Throwable $e) {
    error_log('Server error: ' . $e->getMessage());
    Response::error('Server error', 500);
}
