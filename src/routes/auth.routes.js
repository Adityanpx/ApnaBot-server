const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { protect } = require('../middleware/auth.middleware');
const { loginLimiter, loginIpLimiter, forgotPasswordLimiter } = require('../middleware/rateLimiter.middleware');

router.post('/register', authController.register);
router.post('/verify-email', authController.verifyEmail);
router.post('/resend-verification', authController.resendVerificationOtp);
router.post('/login', loginIpLimiter, loginLimiter, authController.login);
router.post('/admin-login', loginIpLimiter, loginLimiter, authController.adminLogin);
router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);
router.post('/forgot-password', forgotPasswordLimiter, authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);

// The caller's own profile (name, phone; email is read-only)
router.get('/me', protect, authController.getMe);
router.patch('/me', protect, authController.updateMe);

module.exports = router;
