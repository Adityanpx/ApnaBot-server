const express = require('express');
const router = express.Router();
const walletController = require('../controllers/wallet.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');
const { requireWalletEnabled } = require('../middleware/wallet.middleware');

// All routes require: protect, requireBusiness. They 404 while
// WALLET_BILLING_ENABLED is off (the wallet is dormant, so there is nothing to
// read, create or top up).
router.use(protect, requireBusiness, requireWalletEnabled);

// GET / - Current wallet balance
router.get('/', walletController.getWallet);

// GET /transactions - Paginated wallet transaction history
router.get('/transactions', walletController.getWalletTransactions);

// POST /topup/initiate - Create Razorpay order for a wallet top-up
router.post('/topup/initiate', walletController.initiateTopup);

// POST /topup/verify - Verify payment signature and credit the wallet
router.post('/topup/verify', walletController.verifyTopup);

module.exports = router;
