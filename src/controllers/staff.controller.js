const bcrypt = require('bcryptjs');
const supabase = require('../config/supabase');
const subscriptionService = require('../services/subscription.service');
const { successResponse, errorResponse } = require('../utils/response');
const { buildPermissions, revokeAllSessions } = require('../services/auth.service');
const logger = require('../utils/logger');

// A removed or deactivated user must not keep refreshing: end every session.
// The DB change already blocks them, so a Redis failure here is logged, not fatal.
const endSessions = async (userId) => {
  try {
    await revokeAllSessions(userId);
  } catch (err) {
    logger.error(`Failed to revoke sessions for user ${userId}:`, err);
  }
};

const toStaffResponse = (u) => ({
  _id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  businessId: u.business_id,
  isActive: u.is_active,
  lastLoginAt: u.last_login_at,
  permissions: {
    canViewChats: u.can_view_chats,
    canManageRules: u.can_manage_rules,
    canManageBookings: u.can_manage_bookings,
    canViewCustomers: u.can_view_customers,
    canManageBilling: u.can_manage_billing
  }
});

/**
 * GET /api/staff
 * List all staff members in the business
 */
const getStaff = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    const { data: staff, error } = await supabase
      .from('users')
      .select('*')
      .eq('business_id', businessId)
      .eq('role', 'staff')
      .order('created_at', { ascending: false });
    if (error) throw error;

    return successResponse(res, 200, { staff: staff.map(toStaffResponse), total: staff.length });
  } catch (error) {
    logger.error('Error in getStaff:', error);
    next(error);
  }
};

/**
 * POST /api/staff/invite
 * Create a staff account under this business.
 * Validates plan staff limit before creating.
 */
const inviteStaff = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;
    const businessId = req.user.businessId;

    if (!name || !email || !password) {
      return errorResponse(res, 400, 'Name, email, and password are required');
    }
    if (password.length < 6) {
      return errorResponse(res, 400, 'Password must be at least 6 characters');
    }

    // Check plan allows staff
    const subscription = await subscriptionService.getActiveSubscription(businessId);

    if (!subscription) {
      return errorResponse(res, 403, 'No active subscription. Cannot add staff.');
    }
    if (!subscription.plan.staff_enabled) {
      return errorResponse(res, 403, 'Staff feature not available on your plan. Please upgrade.');
    }

    const maxStaff = subscription.plan.max_staff || 0;
    const { count: currentCount } = await supabase
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', businessId)
      .eq('role', 'staff')
      .eq('is_active', true);

    if (currentCount >= maxStaff) {
      return errorResponse(res, 403, `Staff limit reached (${maxStaff}). Please upgrade your plan.`);
    }

    // Check email not already registered
    const { data: existing } = await supabase
      .from('users').select('id').eq('email', email.toLowerCase()).maybeSingle();
    if (existing) return errorResponse(res, 409, 'Email is already registered');

    const permissions = buildPermissions('staff');
    const passwordHash = await bcrypt.hash(password, 12);

    const { data: staffUser, error } = await supabase.from('users').insert({
      name: name.trim(),
      email: email.toLowerCase(),
      password_hash: passwordHash,
      role: 'staff',
      business_id: businessId,
      can_view_chats: permissions.canViewChats,
      can_manage_rules: permissions.canManageRules,
      can_manage_bookings: permissions.canManageBookings,
      can_view_customers: permissions.canViewCustomers,
      can_manage_billing: permissions.canManageBilling,
      is_active: true
    }).select().single();
    if (error) throw error;

    logger.info(`Staff ${staffUser.id} created for business ${businessId}`);
    return successResponse(res, 201, toStaffResponse(staffUser), 'Staff member added successfully');
  } catch (error) {
    logger.error('Error in inviteStaff:', error);
    next(error);
  }
};

/**
 * PUT /api/staff/:id/permissions
 * Update staff permissions — canManageRules and canManageBilling
 * are always enforced as false for staff (hard-coded protection).
 */
const updatePermissions = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { permissions } = req.body;
    const businessId = req.user.businessId;

    if (!permissions || typeof permissions !== 'object') {
      return errorResponse(res, 400, 'permissions object is required');
    }

    const { data: staffMember } = await supabase
      .from('users').select('id').eq('id', id).eq('business_id', businessId).eq('role', 'staff').maybeSingle();
    if (!staffMember) return errorResponse(res, 404, 'Staff member not found');

    // Only these 3 flags are adjustable for staff
    const adjustable = { canViewChats: 'can_view_chats', canManageBookings: 'can_manage_bookings', canViewCustomers: 'can_view_customers' };
    const updates = {};
    for (const [key, col] of Object.entries(adjustable)) {
      if (permissions[key] !== undefined) {
        updates[col] = Boolean(permissions[key]);
      }
    }

    // Hard enforce — staff can never have these
    updates.can_manage_rules = false;
    updates.can_manage_billing = false;

    const { data: updated, error } = await supabase
      .from('users').update(updates).eq('id', id).select().single();
    if (error) throw error;

    return successResponse(res, 200, toStaffResponse(updated), 'Permissions updated');
  } catch (error) {
    logger.error('Error in updatePermissions:', error);
    next(error);
  }
};

/**
 * DELETE /api/staff/:id
 * Permanently remove a staff member
 */
const removeStaff = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: staffMember } = await supabase
      .from('users').select('id').eq('id', id).eq('business_id', businessId).eq('role', 'staff').maybeSingle();
    if (!staffMember) return errorResponse(res, 404, 'Staff member not found');

    const { error } = await supabase.from('users').delete().eq('id', id);
    if (error) throw error;

    await endSessions(id);

    logger.info(`Staff ${id} removed from business ${businessId}`);
    return successResponse(res, 200, null, 'Staff member removed successfully');
  } catch (error) {
    logger.error('Error in removeStaff:', error);
    next(error);
  }
};

/**
 * POST /api/staff/:id/toggle
 * Activate or deactivate a staff member account
 */
const toggleStaff = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: staffMember } = await supabase
      .from('users').select('*').eq('id', id).eq('business_id', businessId).eq('role', 'staff').maybeSingle();
    if (!staffMember) return errorResponse(res, 404, 'Staff member not found');

    const { data: updated, error } = await supabase
      .from('users').update({ is_active: !staffMember.is_active }).eq('id', id).select().single();
    if (error) throw error;

    if (!updated.is_active) await endSessions(id);

    const action = updated.is_active ? 'activated' : 'deactivated';
    logger.info(`Staff ${id} ${action} for business ${businessId}`);

    return successResponse(res, 200, toStaffResponse(updated), `Staff member ${action}`);
  } catch (error) {
    logger.error('Error in toggleStaff:', error);
    next(error);
  }
};

module.exports = {
  getStaff,
  inviteStaff,
  updatePermissions,
  removeStaff,
  toggleStaff
};
