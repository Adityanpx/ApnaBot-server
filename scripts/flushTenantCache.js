/**
 * scripts/flushTenantCache.js
 *
 * Deletes all tenant:* keys from Redis. Needed after any script that
 * updates a business directly in the database (bypassing the app), since
 * tenant.service.js caches business.accessToken for 1 hour and only
 * invalidateTenantCache() (called from normal app flows) clears it early.
 *
 * Usage:
 *   $env:REDIS_URL = 'your-redis-url'
 *   node scripts/flushTenantCache.js
 */
require('dotenv').config();
const { Redis } = require('ioredis');

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error('Missing REDIS_URL env var.');
  process.exit(1);
}

async function main() {
  const redis = new Redis(REDIS_URL, {
    tls: REDIS_URL.startsWith('rediss://') ? {} : undefined,
  });

  const keys = await redis.keys('tenant:*');
  console.log(`Found ${keys.length} cached tenant key(s).`);

  if (keys.length > 0) {
    await redis.del(...keys);
    console.log(`Deleted: ${keys.join(', ')}`);
  }

  redis.disconnect();
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
