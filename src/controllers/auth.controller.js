const bcrypt = require('bcryptjs');
const supabase = require('../config/supabase');
const {
  startSession,
  rotateSession,
  revokeSession,
  revokeAllSessions,
  generateAccessToken,
  verifyAccessToken,
  verifyRefreshToken,
  buildPermissions
} = require('../services/auth.service');
const { errorResponse, successResponse } = require('../utils/response');
const logger = require('../utils/logger');
const { generateResetToken, generateOtp } = require('../utils/crypto');
const redis = require('../config/redis');

const toUserResponse = (user) => ({
  _id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  businessId: user.business_id,
  permissions: {
    canViewChats: user.can_view_chats,
    canManageRules: user.can_manage_rules,
    canManageBookings: user.can_manage_bookings,
    canViewCustomers: user.can_view_customers,
    canManageBilling: user.can_manage_billing
  }
});

const register = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return errorResponse(res, 400, 'Name, email, and password are required');
    }

    if (password.length < 6) {
      return errorResponse(res, 400, 'Password must be at least 6 characters');
    }

    const { data: existingUser } = await supabase
      .from('users').select('id').eq('email', email.toLowerCase()).maybeSingle();
    if (existingUser) {
      return errorResponse(res, 409, 'Email already registered');
    }

    const permissions = buildPermissions('owner');
    const passwordHash = await bcrypt.hash(password, 12);

    const { data: user, error } = await supabase.from('users').insert({
      name,
      email: email.toLowerCase(),
      password_hash: passwordHash,
      role: 'owner',
      business_id: null,
      can_view_chats: permissions.canViewChats,
      can_manage_rules: permissions.canManageRules,
      can_manage_bookings: permissions.canManageBookings,
      can_view_customers: permissions.canViewCustomers,
      can_manage_billing: permissions.canManageBilling,
      is_verified: false
    }).select().single();
    if (error) throw error;

    const otp = generateOtp();

    await redis.set(`verify-email:${user.id}`, otp, 'EX', 600);

    // DEV MODE — log OTP to terminal so you can test without email setup
    logger.info(`DEV MODE — Email verification OTP for ${user.email}: ${otp}`);

    try {
      const emailService = require('../services/email.service');
      await emailService.sendVerificationEmail(user.email, otp, user.name);
    } catch (emailError) {
      // Log but don't fail the request — OTP is saved and logged above
      logger.error('Failed to send verification email:', emailError);
    }

    const payload = {
      userId: user.id,
      businessId: user.business_id,
      role: user.role,
      permissions
    };

    const { accessToken, refreshToken } = await startSession(user.id, payload);

    return successResponse(res, 201, {
      user: toUserResponse(user),
      accessToken,
      refreshToken
    }, 'Registration successful');
  } catch (error) {
    logger.error('Register error:', error);
    next(error);
  }
};

const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return errorResponse(res, 400, 'Email and password are required');
    }

    const { data: user } = await supabase
      .from('users').select('*').eq('email', email.toLowerCase()).maybeSingle();

    if (!user) {
      return errorResponse(res, 401, 'Invalid credentials');
    }

    if (user.is_active === false) {
      return errorResponse(res, 403, 'Account is deactivated');
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return errorResponse(res, 401, 'Invalid credentials');
    }

    if (!user.is_verified) {
      return errorResponse(res, 403, 'Please verify your email before logging in', { code: 'EMAIL_NOT_VERIFIED' });
    }

    await supabase.from('users').update({ last_login_at: new Date().toISOString() }).eq('id', user.id);

    const permissions = {
      canViewChats: user.can_view_chats,
      canManageRules: user.can_manage_rules,
      canManageBookings: user.can_manage_bookings,
      canViewCustomers: user.can_view_customers,
      canManageBilling: user.can_manage_billing
    };

    const payload = {
      userId: user.id,
      businessId: user.business_id,
      role: user.role,
      permissions
    };

    const { accessToken, refreshToken } = await startSession(user.id, payload);

    return successResponse(res, 200, {
      user: toUserResponse(user),
      accessToken,
      refreshToken
    }, 'Login successful');
  } catch (error) {
    logger.error('Login error:', error);
    next(error);
  }
};

const refresh = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return errorResponse(res, 400, 'Refresh token required');
    }

    let decoded;
    try {
      decoded = verifyRefreshToken(refreshToken);
    } catch (err) {
      return errorResponse(res, 401, 'Invalid refresh token');
    }

    // Rotates the session's refresh token; the old one stays valid for a short
    // grace window so parallel or retried refreshes still work.
    const rotated = await rotateSession(decoded);
    if (rotated.status === 'revoked' || rotated.status === 'reused') {
      return errorResponse(res, 401, 'Refresh token expired or revoked');
    }

    const { data: user } = await supabase.from('users').select('*').eq('id', decoded.userId).maybeSingle();
    if (!user || user.is_active === false) {
      await revokeSession(decoded.userId, decoded.sid);
      return errorResponse(res, 401, 'User not found');
    }

    const payload = {
      userId: user.id,
      businessId: user.business_id,
      role: user.role,
      permissions: {
        canViewChats: user.can_view_chats,
        canManageRules: user.can_manage_rules,
        canManageBookings: user.can_manage_bookings,
        canViewCustomers: user.can_view_customers,
        canManageBilling: user.can_manage_billing
      }
    };

    const accessToken = generateAccessToken({ ...payload, sid: decoded.sid });

    return successResponse(res, 200, { accessToken, refreshToken: rotated.refreshToken }, 'Token refreshed');
  } catch (error) {
    logger.error('Refresh error:', error);
    next(error);
  }
};

const logout = async (req, res, next) => {
  try {
    // Ends only the caller's session. It is found from the refresh token in the
    // body if there is one, else from the Bearer access token (an expired one is
    // fine — logout is exactly when it may have lapsed). A client that sends
    // neither has nothing to end and still gets a 200.
    const claims = {};
    const refreshToken = req.body && req.body.refreshToken;
    const bearer = (req.headers.authorization || '').startsWith('Bearer ')
      ? req.headers.authorization.split(' ')[1] : null;
    if (refreshToken) {
      try { Object.assign(claims, verifyRefreshToken(refreshToken)); }
      catch (err) { logger.info('Invalid refresh token during logout'); }
    }
    if (!claims.sid && bearer) {
      try { Object.assign(claims, verifyAccessToken(bearer, { ignoreExpiration: true })); }
      catch (err) { logger.info('Invalid access token during logout'); }
    }

    if (claims.userId && claims.sid) {
      await revokeSession(claims.userId, claims.sid);
    }

    return successResponse(res, 200, null, 'Logged out successfully');
  } catch (error) {
    logger.error('Logout error:', error);
    return successResponse(res, 200, null, 'Logged out successfully');
  }
};

const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      return errorResponse(res, 400, 'Email is required');
    }

    const { data: user } = await supabase
      .from('users').select('*').eq('email', email.toLowerCase()).maybeSingle();

    if (user) {
      const resetToken = generateResetToken();

      // Save to Redis with 1 hour TTL
      await redis.set(`reset:${user.id}`, resetToken, 'EX', 3600);

      // DEV MODE — log token to terminal so you can test without email setup
      logger.info(`DEV MODE — Password reset token for ${email}: ${resetToken}`);

      // Send actual email (fails gracefully if email not configured)
      try {
        const emailService = require('../services/email.service');
        await emailService.sendPasswordResetEmail(user.email, resetToken, user.name);
      } catch (emailError) {
        // Log but don't fail the request — token is saved and logged above
        logger.error('Failed to send reset email:', emailError);
      }
    }

    return successResponse(res, 200, null, 'If this email is registered, a reset link has been sent.');
  } catch (error) {
    logger.error('Forgot password error:', error);
    next(error);
  }
};

const resetPassword = async (req, res, next) => {
  try {
    const { email, token, newPassword } = req.body;

    if (!email || !token || !newPassword) {
      return errorResponse(res, 400, 'Email, token, and newPassword are required');
    }

    if (newPassword.length < 6) {
      return errorResponse(res, 400, 'Password must be at least 6 characters');
    }

    const { data: user } = await supabase
      .from('users').select('*').eq('email', email.toLowerCase()).maybeSingle();
    if (!user) {
      return errorResponse(res, 400, 'Invalid or expired reset token');
    }

    const storedToken = await redis.get(`reset:${user.id}`);
    if (!storedToken || storedToken !== token) {
      return errorResponse(res, 400, 'Invalid or expired reset token');
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await supabase.from('users').update({ password_hash: passwordHash }).eq('id', user.id);

    await redis.del(`reset:${user.id}`);
    await revokeAllSessions(user.id);

    return successResponse(res, 200, null, 'Password reset successfully');
  } catch (error) {
    logger.error('Reset password error:', error);
    next(error);
  }
};

const verifyEmail = async (req, res, next) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return errorResponse(res, 400, 'Email and OTP are required');
    }

    const { data: user } = await supabase
      .from('users').select('*').eq('email', email.toLowerCase()).maybeSingle();
    if (!user) {
      return errorResponse(res, 404, 'User not found');
    }

    if (user.is_verified) {
      return successResponse(res, 200, null, 'Email already verified');
    }

    const storedOtp = await redis.get(`verify-email:${user.id}`);
    if (!storedOtp || storedOtp !== otp) {
      return errorResponse(res, 400, 'Invalid or expired OTP');
    }

    await supabase.from('users').update({ is_verified: true }).eq('id', user.id);

    await redis.del(`verify-email:${user.id}`);

    return successResponse(res, 200, null, 'Email verified successfully');
  } catch (error) {
    logger.error('Verify email error:', error);
    next(error);
  }
};

const resendVerificationOtp = async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      return errorResponse(res, 400, 'Email is required');
    }

    const { data: user } = await supabase
      .from('users').select('*').eq('email', email.toLowerCase()).maybeSingle();
    if (!user) {
      return errorResponse(res, 404, 'User not found');
    }

    if (user.is_verified) {
      return successResponse(res, 200, null, 'Email already verified');
    }

    const otp = generateOtp();

    await redis.set(`verify-email:${user.id}`, otp, 'EX', 600);

    // DEV MODE — log OTP to terminal so you can test without email setup
    logger.info(`DEV MODE — Email verification OTP for ${user.email}: ${otp}`);

    try {
      const emailService = require('../services/email.service');
      await emailService.sendVerificationEmail(user.email, otp, user.name);
    } catch (emailError) {
      logger.error('Failed to send verification email:', emailError);
    }

    return successResponse(res, 200, null, 'Verification code sent');
  } catch (error) {
    logger.error('Resend verification OTP error:', error);
    next(error);
  }
};

module.exports = {
  register,
  login,
  refresh,
  logout,
  forgotPassword,
  resetPassword,
  verifyEmail,
  resendVerificationOtp
};
