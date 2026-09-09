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
