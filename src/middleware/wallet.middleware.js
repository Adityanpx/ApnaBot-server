const config = require('../config/env');
const { errorResponse } = require('../utils/response');

// The wallet is dormant while WALLET_BILLING_ENABLED is off (see config/env.js):
// no top-ups, no balance reads, and no wallet row created as a side effect.
// The flag is read per request so it can't be captured stale at require time.
const requireWalletEnabled = (req, res, next) => {
  if (!config.WALLET_BILLING_ENABLED) {
    return errorResponse(res, 404, 'Wallet is not enabled');
  }
  next();
};

module.exports = { requireWalletEnabled };
