<?php
class Google
{
    /**
     * Verifies a Google ID token (the JWT `credential` from Google Identity
     * Services) and returns its claims (email, name, picture, ...), or null
     * if it doesn't check out. Uses Google's tokeninfo endpoint rather than
     * verifying the RS256 signature locally, to avoid pulling in Google's
     * JWKS-handling library for one endpoint.
     */
    public static function verifyIdToken(string $idToken): ?array
    {
        $url = 'https://oauth2.googleapis.com/tokeninfo?id_token=' . urlencode($idToken);
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 6,
        ]);
        $resp = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($resp === false || $code !== 200) return null;
        $data = json_decode($resp, true);
        if (!is_array($data) || empty($data['email'])) return null;

        $clientId = getenv('GOOGLE_CLIENT_ID');
        if ($clientId && ($data['aud'] ?? '') !== $clientId) return null;

        $verified = $data['email_verified'] ?? 'false';
        if ($verified !== 'true' && $verified !== true) return null;

        return $data;
    }
}
