<?php
require_once __DIR__ . '/../vendor/autoload.php';

use Firebase\JWT\JWT;
use Firebase\JWT\Key;

class Auth
{
    private static function secret(): string
    {
        $s = getenv('JWT_SECRET');
        if (!$s) {
            // Fail loudly rather than silently signing tokens nobody can trust.
            Response::error('Server misconfigured: JWT_SECRET is not set', 500);
        }
        return $s;
    }

    public static function sign(string $email): string
    {
        $now = time();
        $payload = ['email' => $email, 'iat' => $now, 'exp' => $now + 60 * 60 * 24 * 30];
        return JWT::encode($payload, self::secret(), 'HS256');
    }

    public static function verify(string $token): ?string
    {
        try {
            $decoded = JWT::decode($token, new Key(self::secret(), 'HS256'));
            return $decoded->email ?? null;
        } catch (\Throwable $e) {
            return null;
        }
    }

    public static function bearerToken(): ?string
    {
        $hdr = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
        if ($hdr === '' && function_exists('apache_request_headers')) {
            $all = apache_request_headers();
            $hdr = $all['Authorization'] ?? ($all['authorization'] ?? '');
        }
        if (strpos($hdr, 'Bearer ') === 0) {
            return substr($hdr, 7);
        }
        return null;
    }

    public static function tokenEmail(): ?string
    {
        $token = self::bearerToken();
        if (!$token) return null;
        return self::verify($token);
    }

    /** Returns the users row for the bearer token, or null if absent/invalid. */
    public static function currentUser(PDO $pdo): ?array
    {
        $email = self::tokenEmail();
        if (!$email) return null;
        $stmt = $pdo->prepare('SELECT * FROM users WHERE email = :email');
        $stmt->execute(['email' => $email]);
        $user = $stmt->fetch();
        return $user ?: null;
    }

    /** Ends the request with 401 if not authenticated; otherwise returns the user row. */
    public static function requireAuth(PDO $pdo): array
    {
        $user = self::currentUser($pdo);
        if (!$user) {
            Response::error('Not authenticated', 401);
        }
        return $user;
    }

    public static function requireAdmin(array $user): void
    {
        if (empty($user['is_admin']) || $user['is_admin'] === 'f') {
            Response::error('Admin access required', 403);
        }
    }
}
