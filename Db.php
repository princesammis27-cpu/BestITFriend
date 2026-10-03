<?php
class Db
{
    private static ?PDO $pdo = null;

    public static function get(): PDO
    {
        if (self::$pdo === null) {
            $host    = getenv('DB_HOST') ?: '127.0.0.1';
            $port    = getenv('DB_PORT') ?: '5432';
            $name    = getenv('DB_NAME') ?: 'postgres';
            $user    = getenv('DB_USER') ?: 'postgres';
            $pass    = getenv('DB_PASSWORD') ?: '';
            $sslmode = getenv('DB_SSLMODE') ?: 'prefer';

            $dsn = "pgsql:host={$host};port={$port};dbname={$name};sslmode={$sslmode}";
            self::$pdo = new PDO($dsn, $user, $pass, [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            ]);
        }
        return self::$pdo;
    }
}
