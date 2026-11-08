/**
 * Integration tests use their own database, "<name>_test", next to the development database,
 * so running tests never wipes development data.
 */
export function testDatabaseUrl(databaseUrl: string | undefined): string {
  if (!databaseUrl) throw new Error('DATABASE_URL is not set. Copy .env.example to .env (see README).');
  const url = new URL(databaseUrl);
  const name = url.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) url.pathname = `/${name}_test`;
  return url.toString();
}

/** Tests use Redis database 1, so they can clear rate-limit and MFA counters without touching development data. */
export function testRedisUrl(redisUrl: string | undefined): string {
  if (!redisUrl) throw new Error('REDIS_URL is not set. Copy .env.example to .env (see README).');
  const url = new URL(redisUrl);
  url.pathname = '/1';
  return url.toString();
}
