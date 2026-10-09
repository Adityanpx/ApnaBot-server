const http = require('http');
const app = require('./src/app');
const redis = require('./src/config/redis');
const logger = require('./src/utils/logger');
const config = require('./src/config/env');
const socketService = require('./src/services/socket.service');

const server = http.createServer(app);

// Initialize Socket.io with socket service
socketService.initialize(server);

// Store io instance for later use
app.set('io', socketService.getIO());

// Start BullMQ worker (for processing message queue)
try {
  require('./src/queues/whatsapp.worker');
  logger.info('BullMQ worker started');
} catch (err) {
  logger.warn('BullMQ worker not started (Redis may not be available):', err.message);
}

try {
  require('./src/queues/broadcast.worker');
  logger.info('Broadcast BullMQ worker started');
} catch (err) {
  logger.warn('Broadcast BullMQ worker not started (Redis may not be available):', err.message);
}

try {
  require('./src/queues/sessionTimeout.worker');
  logger.info('Session timeout BullMQ worker started');
} catch (err) {
  logger.warn('Session timeout BullMQ worker not started (Redis may not be available):', err.message);
}

try {
  require('./src/queues/demoReminder.worker');
  logger.info('Demo reminder BullMQ worker started');
} catch (err) {
  logger.warn('Demo reminder BullMQ worker not started (Redis may not be available):', err.message);
}

// ── Subscription Expiry Cron (every 24 hours) ──────────────────────────────
const subscriptionService = require('./src/services/subscription.service');

const runDailyExpiryCheck = async () => {
  try {
    const count = await subscriptionService.runExpiryCheck();
    logger.info(`Expiry check complete. ${count.expiredCount} expired, ${count.pausedCount} paused.`);
  } catch (err) {
    logger.error('Subscription expiry cron failed:', err);
  }
};

// Run once on startup to catch any missed expiries, then every 24 hours
runDailyExpiryCheck();
setInterval(runDailyExpiryCheck, 24 * 60 * 60 * 1000);

logger.info('Subscription expiry cron scheduled (runs every 24h)');

// ── Follow-up automations sweeper (every 15 min) ───────────────────────────
// Off unless ENABLE_FOLLOWUP_SWEEPER=true — see config/env.js for why it
// must stay off everywhere but the production server. In-process timer, no
// BullMQ/Redis: while the instance sleeps nothing runs, and the next sweep
// after waking picks up whoever is due then. A tick that finds the previous
// sweep still running is skipped.
if (config.ENABLE_FOLLOWUP_SWEEPER) {
  const followupSweepService = require('./src/services/followupSweep.service');
  const FOLLOWUP_SWEEP_FIRST_DELAY_MS = 60 * 1000;
  const FOLLOWUP_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
  let followupSweepRunning = false;

  const runFollowupSweep = async () => {
    if (followupSweepRunning) {
      logger.warn('Follow-up sweep still running — skipping this tick');
      return;
    }
    followupSweepRunning = true;
    try {
      await followupSweepService.runSweep();
    } catch (err) {
      logger.error('Follow-up sweep failed:', err);
    } finally {
      followupSweepRunning = false;
    }
  };

  setTimeout(() => {
    runFollowupSweep();
    setInterval(runFollowupSweep, FOLLOWUP_SWEEP_INTERVAL_MS);
  }, FOLLOWUP_SWEEP_FIRST_DELAY_MS);
  logger.info('Follow-up sweeper scheduled (first run in 60 s, then every 15 min)');
}

// ── Storage cleanup sweeper (every 15 min) ────────────────────────────────
// Off unless ENABLE_STORAGE_SWEEPER=true (config/env.js). Purges the R2 files of
// cleanup runs whose 24h pending window has passed, and once a day creates the
// automatic chat-media retention run. In-process timer like the follow-up
// sweeper; a tick that finds the previous one still running is skipped, and
// claims are atomic in the database so two instances cannot purge the same item.
if (config.ENABLE_STORAGE_SWEEPER) {
  const storageSweeper = require('./src/services/storageCleanupSweeper.service');
  const STORAGE_SWEEP_FIRST_DELAY_MS = 2 * 60 * 1000;
  const STORAGE_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
  let storageSweepRunning = false;

  const runStorageSweep = async () => {
    if (storageSweepRunning) {
      logger.warn('Storage cleanup sweep still running — skipping this tick');
      return;
    }
    storageSweepRunning = true;
    try {
      await storageSweeper.runTick();
    } catch (err) {
      logger.error('Storage cleanup sweep failed:', err);
    } finally {
      storageSweepRunning = false;
    }
  };

  setTimeout(() => {
    runStorageSweep();
    setInterval(runStorageSweep, STORAGE_SWEEP_INTERVAL_MS);
  }, STORAGE_SWEEP_FIRST_DELAY_MS);
  logger.info('Storage cleanup sweeper scheduled (first run in 2 min, then every 15 min)');
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  logger.error('Unhandled Rejection:', err);
  server.close(() => {
    process.exit(1);
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
  server.close(() => {
    process.exit(1);
  });
});

// Start server
server.listen(config.PORT, () => {
  logger.info(`Server running on port ${config.PORT}`);
});
