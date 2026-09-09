const supabase = require('../config/supabase');
const { toCamelCase } = require('../utils/caseConvert');
const bookingService = require('../services/booking.service');
const subscriptionService = require('../services/subscription.service');
const tenantService = require('../services/tenant.service');
const adminService = require('../services/admin.service');
const { invalidateRulesCache } = require('../services/chatbot.service');
const { successResponse, errorResponse } = require('../utils/response');
const { getPagination } = require('../utils/pagination');
const logger = require('../utils/logger');

// Tables with business_id and ON DELETE CASCADE on the businesses FK (see
// supabase/migrations/20260819213717_init_schema.sql and
// 20260829140000_flow_nodes_edges.sql) — deleting the business row
// atomically wipes these in the same statement, so they're only counted
// here (for the response) rather than deleted individually.
const CASCADE_DELETED_TABLES = [
  'customers', 'bookings', 'vehicles', 'route_fares',
  'rental_packages', 'messages', 'message_templates', 'broadcasts',
  'usage', 'subscriptions',
  'flow_nodes', 'flow_edges', 'flow_snapshots'
];

const toCamelCaseDeep = (row, nestedKeys = []) => {
  if (!row) return row;
  const result = toCamelCase(row);
  for (const key of nestedKeys) {
    if (result[key]) result[key] = toCamelCase(result[key]);
  }
  return result;
};

/**
 * GET /api/admin/businesses
 * List all businesses — paginated + searchable
 */
const getBusinesses = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search, isActive, businessCategory } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const from = (pageNum - 1) * limitNum;
    const to = from + limitNum - 1;

    let query = supabase.from('businesses').select('*', { count: 'exact' });

    if (search) query = query.or(`name.ilike.%${search}%,city.ilike.%${search}%`);
    if (isActive !== undefined) query = query.eq('is_active', isActive === 'true');
    if (businessCategory) query = query.eq('business_category', businessCategory);

    const { data, error, count } = await query.order('created_at', { ascending: false }).range(from, to);
    if (error) throw error;

    const rows = data || [];
    const ownerIds = [...new Set(rows.map((b) => b.owner_user_id).filter(Boolean))];
    let ownersById = {};
    if (ownerIds.length > 0) {
      const { data: owners, error: ownersErr } = await supabase
        .from('users').select('id, name, email').in('id', ownerIds);
      if (ownersErr) throw ownersErr;
      ownersById = Object.fromEntries((owners || []).map((o) => [o.id, o]));
    }

    const businesses = rows.map((b) => {
      const { access_token, ...safeRow } = b; // never expose encrypted token
      const owner = ownersById[b.owner_user_id];
      return { ...toCamelCase(safeRow), ownerUserId: owner ? toCamelCase(owner) : b.owner_user_id };
    });

    const pagination = getPagination(count || 0, pageNum, limitNum);
    return successResponse(res, 200, { businesses, pagination });
  } catch (error) {
    logger.error('Error in getBusinesses:', error);
    next(error);
  }
};

/**
 * GET /api/admin/businesses/:id
 * Get full business detail — includes subscription + usage + users + stats
 */
const getBusinessById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: businessRow, error: bizErr } = await supabase
      .from('businesses').select('*').eq('id', id).maybeSingle();
    if (bizErr) throw bizErr;
    if (!businessRow) return errorResponse(res, 404, 'Business not found');
    const { access_token, ...safeBusinessRow } = businessRow;

    const [ownerRes, staffRes, subRes, customerCountRes, bookingCountRes] = await Promise.all([
      supabase.from('users').select('id, name, email, role, last_login_at, is_active')
        .eq('id', businessRow.owner_user_id).maybeSingle(),
      supabase.from('users').select('id, name, email, role, last_login_at, is_active')
        .eq('business_id', id).eq('role', 'staff'),
      supabase.from('subscriptions').select('*, plan:plans(*)')
        .eq('business_id', id).in('status', ['active', 'trial'])
        .order('created_at', { ascending: false }).limit(1),
      supabase.from('customers').select('*', { count: 'exact', head: true }).eq('business_id', id),
      supabase.from('bookings').select('*', { count: 'exact', head: true }).eq('business_id', id)
    ]);
    if (ownerRes.error) throw ownerRes.error;
    if (staffRes.error) throw staffRes.error;
    if (subRes.error) throw subRes.error;
    if (customerCountRes.error) throw customerCountRes.error;
    if (bookingCountRes.error) throw bookingCountRes.error;

    const owner = ownerRes.data ? toCamelCase(ownerRes.data) : null;
    const staff = (staffRes.data || []).map(toCamelCase);
    const users = owner ? [owner, ...staff] : staff;

    const subscriptionRow = (subRes.data || [])[0] || null;
    const subscription = subscriptionRow ? toCamelCaseDeep(subscriptionRow, ['plan']) : null;

    return successResponse(res, 200, {
      business: { ...toCamelCase(safeBusinessRow), ownerUserId: owner || safeBusinessRow.owner_user_id },
      subscription,
      plan: subscription?.plan || null,
      users,
      userCount: users.length,
      customerCount: customerCountRes.count || 0,
      bookingCount: bookingCountRes.count || 0
    });
  } catch (error) {
    logger.error('Error in getBusinessById:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/businesses/:id/toggle
 * Activate or deactivate a business
 */
const toggleBusiness = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: business, error: fetchErr } = await supabase
      .from('businesses').select('id, is_active').eq('id', id).maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!business) return errorResponse(res, 404, 'Business not found');

    const newIsActive = !business.is_active;
    const { error: updateErr } = await supabase
      .from('businesses').update({ is_active: newIsActive }).eq('id', id);
    if (updateErr) throw updateErr;

    const action = newIsActive ? 'activated' : 'deactivated';
    logger.info(`Business ${id} ${action} by superadmin`);

    return successResponse(res, 200, { isActive: newIsActive }, `Business ${action} successfully`);
  } catch (error) {
    logger.error('Error in toggleBusiness:', error);
    next(error);
  }
};

/**
 * DELETE /api/admin/businesses/:id
 * Permanently delete a business and cascade-delete every row that belongs to it.
 *
 * customers, bookings, vehicles, route_fares, rental_packages, messages,
 * message_templates, broadcasts, usage, subscriptions, and
 * flow_nodes/flow_edges/flow_snapshots (graph booking engine) all have ON
 * DELETE CASCADE on their business_id FK, so deleting the business row wipes
 * them in one atomic DB statement — no manual per-table deletes needed (and
 * no risk of a partial failure among them).
 *
 * users.business_id has NO cascade, and businesses.owner_user_id is a NOT NULL
 * FK back to users — a circular reference — so owner/staff users need explicit
 * handling in this order:
 *   1. delete staff users (business_id = this business, role = 'staff')
 *   2. null out the owner's business_id (unblocks deleting the business row)
 *   3. delete the business row (cascades the 13 tables above)
 *   4. delete the owner user row (unblocked now that the business row is gone)
 *
 * NOT deleted: plans, business_type_templates, vehicle_type_catalog
 * (shared/global, not business-owned).
 */
const deleteBusiness = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: business, error: fetchErr } = await supabase
      .from('businesses').select('id, name, owner_user_id, phone_number_id').eq('id', id).maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!business) return errorResponse(res, 404, 'Business not found');

    // Pre-count cascade-covered tables so the response can confirm what was removed
    const cascadeCounts = {};
    for (const table of CASCADE_DELETED_TABLES) {
      const { count, error } = await supabase
        .from(table).select('id', { count: 'exact', head: true }).eq('business_id', id);
      if (error) throw error;
      cascadeCounts[table] = count || 0;
    }

    const { count: staffCount, error: staffCountErr } = await supabase
      .from('users').select('id', { count: 'exact', head: true })
      .eq('business_id', id).eq('role', 'staff');
    if (staffCountErr) throw staffCountErr;

    logger.info(`[deleteBusiness] business=${id} (${business.name}) — starting delete. Row counts: ${JSON.stringify({ ...cascadeCounts, staffUsers: staffCount || 0 })}`);

    // 1. Delete staff users tied to this business — nothing else references them
    const { error: staffDelErr } = await supabase
      .from('users').delete().eq('business_id', id).eq('role', 'staff');
    if (staffDelErr) {
      logger.error(`[deleteBusiness] business=${id} — failed deleting staff users, nothing else was touched:`, staffDelErr);
      throw staffDelErr;
    }
    logger.info(`[deleteBusiness] business=${id} — deleted ${staffCount || 0} staff user(s)`);

    // 2. Unlink the owner so users.business_id no longer blocks deleting the business row
    const { error: ownerUnlinkErr } = await supabase
      .from('users').update({ business_id: null }).eq('id', business.owner_user_id);
    if (ownerUnlinkErr) {
      logger.error(`[deleteBusiness] business=${id} — failed unlinking owner ${business.owner_user_id}, business row and owner user are untouched:`, ownerUnlinkErr);
      throw ownerUnlinkErr;
    }
    logger.info(`[deleteBusiness] business=${id} — unlinked owner ${business.owner_user_id} from business`);

    // 3. Delete the business row — cascades customers/bookings/vehicles/
    // route_fares/rental_packages/messages/message_templates/broadcasts/usage/subscriptions
    const { error: bizDelErr } = await supabase.from('businesses').delete().eq('id', id);
    if (bizDelErr) {
      logger.error(`[deleteBusiness] business=${id} — failed deleting business row. Owner ${business.owner_user_id} is now unlinked but not deleted — rerun or manually delete the owner user if this business is not recovered:`, bizDelErr);
      throw bizDelErr;
    }
    logger.info(`[deleteBusiness] business=${id} — deleted business row (cascaded ${JSON.stringify(cascadeCounts)})`);

    // 4. Delete the owner user row now that nothing references it
    const { error: ownerDelErr } = await supabase
      .from('users').delete().eq('id', business.owner_user_id);
    if (ownerDelErr) {
      logger.error(`[deleteBusiness] business=${id} — business row and all its data are deleted, but failed deleting owner user ${business.owner_user_id}. Orphaned unlinked user needs manual cleanup:`, ownerDelErr);
      throw ownerDelErr;
    }
    logger.info(`[deleteBusiness] business=${id} — deleted owner user ${business.owner_user_id}`);

    // Flush caches for this business
    await invalidateRulesCache(id);
    await subscriptionService.invalidateSubscriptionCache(id);
    if (business.phone_number_id) {
      await tenantService.invalidateTenantCache(business.phone_number_id);
    }

    logger.info(`Business ${id} (${business.name}) permanently deleted by superadmin`);
    return successResponse(res, 200, {
      businessId: id,
      businessName: business.name,
      deleted: {
        business: 1,
        ownerUser: 1,
        staffUsers: staffCount || 0,
        ...cascadeCounts
      }
    }, 'Business and all related data deleted successfully');
  } catch (error) {
    logger.error('Error in deleteBusiness:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/businesses/:id/plan
 * Manually change a business's subscription plan
 */
const changeBusinessPlan = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { planId } = req.body;

    if (!planId) return errorResponse(res, 400, 'planId is required');

    const { data: business, error: bizErr } = await supabase
      .from('businesses').select('id, phone_number_id').eq('id', id).maybeSingle();
    if (bizErr) throw bizErr;
    if (!business) return errorResponse(res, 404, 'Business not found');

    const { data: plan, error: planErr } = await supabase
      .from('plans').select('*').eq('id', planId).maybeSingle();
    if (planErr) throw planErr;
    if (!plan || !plan.is_active) return errorResponse(res, 404, 'Plan not found');

    const subscription = await subscriptionService.createSubscription(id, planId, {
      status: 'active'
    });

    const { data: populated, error: popErr } = await supabase
      .from('subscriptions').select('*, plan:plans(*)').eq('id', subscription.id).maybeSingle();
    if (popErr) throw popErr;

    // Clear cached subscription status so the new plan takes effect immediately
    await subscriptionService.invalidateSubscriptionCache(id);
    // Also clear the webhook's tenant cache, which stores its own subscription snapshot
    if (business.phone_number_id) {
      await tenantService.invalidateTenantCache(business.phone_number_id);
    }

    logger.info(`Business ${id} plan changed to ${plan.name} by superadmin`);
    return successResponse(res, 200, { subscription: toCamelCaseDeep(populated, ['plan']) }, 'Plan changed successfully');
  } catch (error) {
    logger.error('Error in changeBusinessPlan:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/businesses/:id/extend
 * Extend a business's subscription expiry by N days
 */
const extendSubscription = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { days = 30 } = req.body;

    const { data: subs, error: subErr } = await supabase
      .from('subscriptions').select('*').eq('business_id', id).in('status', ['active', 'expired'])
      .order('created_at', { ascending: false }).limit(1);
    if (subErr) throw subErr;
    const sub = (subs || [])[0];

    if (!sub) return errorResponse(res, 404, 'No subscription found for this business');

    const currentEnd = new Date(sub.end_date) > new Date() ? new Date(sub.end_date) : new Date();
    const newEndDate = new Date(currentEnd.getTime() + days * 24 * 60 * 60 * 1000);

    const { data: updatedSub, error: updateErr } = await supabase
      .from('subscriptions').update({ end_date: newEndDate.toISOString(), status: 'active' })
      .eq('id', sub.id).select().single();
    if (updateErr) throw updateErr;

    // Reactivate business if it was deactivated
    const { data: updatedBusiness, error: bizErr } = await supabase
      .from('businesses').update({ is_active: true }).eq('id', id).select('phone_number_id').single();
    if (bizErr) throw bizErr;

    // Clear Redis cache
    await subscriptionService.invalidateSubscriptionCache(id);
    // Also clear the webhook's tenant cache, which stores its own subscription snapshot
    if (updatedBusiness?.phone_number_id) {
      await tenantService.invalidateTenantCache(updatedBusiness.phone_number_id);
    }

    logger.info(`Business ${id} subscription extended by ${days} days by superadmin`);
    return successResponse(res, 200, toCamelCase(updatedSub), `Subscription extended by ${days} days`);
  } catch (error) {
    logger.error('Error in extendSubscription:', error);
    next(error);
  }
};

/**
 * POST /api/admin/businesses/:id/grant-subscription
 * Manually grant/override a subscription for a business — superadmin-only,
 * bypasses payment entirely. Full control over status and duration; does not
 * touch auto_renew or razorpay_* columns, which stay at their table defaults
 * (auto_renew=true, razorpay ids null) so manual grants are distinguishable
 * from Razorpay-paid subscriptions.
 */
const VALID_SUBSCRIPTION_STATUSES = ['trial', 'active', 'expired', 'cancelled'];

const grantSubscription = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { planId, status, durationDays } = req.body;

    if (!planId) return errorResponse(res, 400, 'planId is required');
    if (!VALID_SUBSCRIPTION_STATUSES.includes(status)) {
      return errorResponse(res, 400, `status must be one of: ${VALID_SUBSCRIPTION_STATUSES.join(', ')}`);
    }
    if (!Number.isInteger(durationDays) || durationDays <= 0) {
      return errorResponse(res, 400, 'durationDays must be a positive integer');
    }

    const { data: business, error: bizErr } = await supabase
      .from('businesses').select('id, phone_number_id').eq('id', id).maybeSingle();
    if (bizErr) throw bizErr;
    if (!business) return errorResponse(res, 404, 'Business not found');

    const { data: plan, error: planErr } = await supabase
      .from('plans').select('id').eq('id', planId).maybeSingle();
    if (planErr) throw planErr;
    if (!plan) return errorResponse(res, 404, 'Plan not found');

    // Cancel any existing active subscription first — same guard
    // subscriptionService.createSubscription uses — otherwise this insert
    // leaves two 'active' rows for the business, which breaks every
    // .eq('status','active').maybeSingle() query downstream (tenant
    // resolution, plan checks) with a PGRST116 "multiple rows" error.
    const { error: cancelErr } = await supabase
      .from('subscriptions')
      .update({ status: 'cancelled' })
      .eq('business_id', id)
      .eq('status', 'active');
    if (cancelErr) throw cancelErr;

    const startDate = new Date();
    const endDate = new Date(startDate.getTime() + durationDays * 24 * 60 * 60 * 1000);

    const { data: subscription, error } = await supabase
      .from('subscriptions')
      .insert({
        business_id: id,
        plan_id: planId,
        status,
        start_date: startDate.toISOString(),
        end_date: endDate.toISOString()
      })
      .select('*, plan:plans(*)')
      .single();
    if (error) throw error;

    // Clear cached subscription status so the grant takes effect immediately
    await subscriptionService.invalidateSubscriptionCache(id);
    if (business.phone_number_id) {
      await tenantService.invalidateTenantCache(business.phone_number_id);
    }

    logger.info(`Subscription manually granted for business ${id} — plan ${planId}, status ${status}, ${durationDays}d by superadmin`);
    return successResponse(res, 201, { subscription: toCamelCaseDeep(subscription, ['plan']) }, 'Subscription granted successfully');
  } catch (error) {
    logger.error('Error in grantSubscription:', error);
    next(error);
  }
};

/**
 * GET /api/admin/businesses/:id/subscription-history
 * List all subscription rows for a business, newest first
 */
const getSubscriptionHistory = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: business, error: bizErr } = await supabase
      .from('businesses').select('id').eq('id', id).maybeSingle();
    if (bizErr) throw bizErr;
    if (!business) return errorResponse(res, 404, 'Business not found');

    const { data: subscriptions, error } = await supabase
      .from('subscriptions').select('*, plan:plans(*)')
      .eq('business_id', id)
      .order('created_at', { ascending: false });
    if (error) throw error;

    return successResponse(res, 200, {
      subscriptions: (subscriptions || []).map((s) => toCamelCaseDeep(s, ['plan']))
    });
  } catch (error) {
    logger.error('Error in getSubscriptionHistory:', error);
    next(error);
  }
};

/**
 * GET /api/admin/businesses/:businessId/flow-snapshots
 * This business's own saved flow versions (is_category_template: false) —
 * light list-view shape, no nodes/edges. Powers the "Clone from Business"
 * modal's choice between the live graph and one of this business's saved
 * Versions-tab snapshots.
 */
const getBusinessFlowSnapshots = async (req, res, next) => {
  try {
    const { businessId } = req.params;

    const { data: business, error: bizErr } = await supabase
      .from('businesses').select('id').eq('id', businessId).maybeSingle();
    if (bizErr) throw bizErr;
    if (!business) return errorResponse(res, 404, 'Business not found');

    const { data, error } = await supabase
      .from('flow_snapshots')
      .select('id, name, description, created_at, updated_at')
      .eq('business_id', businessId)
      .eq('is_category_template', false)
      .order('created_at', { ascending: false });
    if (error) throw error;

    return successResponse(res, 200, { snapshots: (data || []).map(toCamelCase) });
  } catch (error) {
    logger.error('Error in getBusinessFlowSnapshots:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/businesses/:id/preview-credits
 * Grant additional purchased preview credits to a business — superadmin-only.
 * Additive: adds `amount` to the business's existing previewCreditsPurchased
 * rather than overwriting it, so repeated grants over time accumulate (mirrors
 * grantSubscription's cancel-then-insert-fresh-row pattern in spirit — this
 * one's an additive column bump instead, since previewCreditsPurchased is a
 * running balance, not a point-in-time row). Same credit pool
 * checkAndConsumeManualPreviewCredit/getPreviewCreditsStatus already read
 * from, not a separate counter.
 */
const grantPreviewCredits = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { amount } = req.body;

    if (!Number.isInteger(amount) || amount <= 0) {
      return errorResponse(res, 400, 'amount must be a positive integer');
    }

    const { data: business, error: bizErr } = await supabase
      .from('businesses')
      .select('preview_credits_used, preview_credits_reset_at, preview_credits_purchased')
      .eq('id', id).maybeSingle();
    if (bizErr) throw bizErr;
    if (!business) return errorResponse(res, 404, 'Business not found');

    const newPurchased = (business.preview_credits_purchased || 0) + amount;

    const { data: updated, error: updateErr } = await supabase
      .from('businesses')
      .update({ preview_credits_purchased: newPurchased })
      .eq('id', id)
      .select('preview_credits_used, preview_credits_reset_at, preview_credits_purchased')
      .single();
    if (updateErr) throw updateErr;

    const { remaining } = bookingService.getPreviewCreditsStatus(toCamelCase(updated));

    logger.info(`Granted ${amount} preview credits to business ${id} by superadmin — previewCreditsPurchased now ${newPurchased}`);
    return successResponse(res, 200, {
      previewCreditsPurchased: newPurchased,
      previewCreditsRemaining: remaining
    }, 'Preview credits granted successfully');
  } catch (error) {
    logger.error('Error in grantPreviewCredits:', error);
    next(error);
  }
};

/**
 * GET /api/admin/stats
 * Platform-wide statistics
 */
const getPlatformStats = async (req, res, next) => {
  try {
    const stats = await adminService.getPlatformStats();
    return successResponse(res, 200, stats);
  } catch (error) {
    logger.error('Error in getPlatformStats:', error);
    next(error);
  }
};

/**
 * GET /api/admin/revenue
 * Monthly revenue report (last 6 months by default)
 */
const getRevenueReport = async (req, res, next) => {
  try {
    const { months = 6 } = req.query;
    const report = await adminService.getRevenueReport(parseInt(months));
    return successResponse(res, 200, { report });
  } catch (error) {
    logger.error('Error in getRevenueReport:', error);
    next(error);
  }
};

/**
 * GET /api/admin/plans
 * List all plans (including inactive)
 */
const getPlans = async (req, res, next) => {
  try {
    const { data: plans, error } = await supabase
      .from('plans').select('*').order('price', { ascending: true });
    if (error) throw error;
    return successResponse(res, 200, { plans: (plans || []).map(toCamelCase) });
  } catch (error) {
    logger.error('Error in getPlans:', error);
    next(error);
  }
};

/**
 * POST /api/admin/plans
 * Create a new plan
 */
const createPlan = async (req, res, next) => {
  try {
    const {
      name, displayName, price, msgLimit, ruleLimit,
      customerLimit, bookingEnabled, paymentLinkEnabled,
      staffEnabled, maxStaff, durationOptions
    } = req.body;

    if (!name || !displayName || price === undefined) {
      return errorResponse(res, 400, 'name, displayName, and price are required');
    }

    const { data: existing } = await supabase
      .from('plans').select('id').eq('name', name).maybeSingle();
    if (existing) return errorResponse(res, 409, 'A plan with this name already exists');

    const { data: plan, error } = await supabase.from('plans').insert({
      name, display_name: displayName, price,
      msg_limit: msgLimit ?? 500,
      rule_limit: ruleLimit ?? 10,
      customer_limit: customerLimit ?? 100,
      booking_enabled: bookingEnabled ?? true,
      payment_link_enabled: paymentLinkEnabled ?? false,
      staff_enabled: staffEnabled ?? false,
      max_staff: maxStaff ?? 0,
      is_active: true,
      duration_options: durationOptions || [{ months: 1, price, label: 'Monthly', discount: 0 }]
    }).select().single();
    if (error) throw error;

    logger.info(`Plan ${plan.name} created by superadmin`);
    return successResponse(res, 201, toCamelCase(plan), 'Plan created successfully');
  } catch (error) {
    logger.error('Error in createPlan:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/plans/:id
 * Update an existing plan
 */
const updatePlan = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: existingPlan } = await supabase.from('plans').select('id').eq('id', id).maybeSingle();
    if (!existingPlan) return errorResponse(res, 404, 'Plan not found');

    const allowedFields = [
      'displayName', 'price', 'msgLimit', 'ruleLimit', 'customerLimit',
      'bookingEnabled', 'paymentLinkEnabled', 'staffEnabled', 'maxStaff', 'isActive',
      'durationOptions'
    ];
    const fieldMap = {
      displayName: 'display_name', msgLimit: 'msg_limit', ruleLimit: 'rule_limit',
      customerLimit: 'customer_limit', bookingEnabled: 'booking_enabled',
      paymentLinkEnabled: 'payment_link_enabled', staffEnabled: 'staff_enabled',
      maxStaff: 'max_staff', isActive: 'is_active', price: 'price',
      durationOptions: 'duration_options'
    };

    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) updates[fieldMap[field]] = req.body[field];
    }

    const { data: plan, error } = await supabase
      .from('plans').update(updates).eq('id', id).select().single();
    if (error) throw error;

    logger.info(`Plan ${id} updated by superadmin`);
    return successResponse(res, 200, toCamelCase(plan), 'Plan updated successfully');
  } catch (error) {
    logger.error('Error in updatePlan:', error);
    next(error);
  }
};

/**
 * DELETE /api/admin/plans/:id
 * Soft delete — marks plan as inactive
 */
const deletePlan = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: plan } = await supabase.from('plans').select('id').eq('id', id).maybeSingle();
    if (!plan) return errorResponse(res, 404, 'Plan not found');

    const { count: activeCount, error: countErr } = await supabase
      .from('subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('plan_id', id).eq('status', 'active');
    if (countErr) throw countErr;

    if (activeCount > 0) {
      return errorResponse(res, 400, `Cannot delete — ${activeCount} active subscriptions use this plan`);
    }

    const { error } = await supabase.from('plans').update({ is_active: false }).eq('id', id);
    if (error) throw error;

    logger.info(`Plan ${id} deactivated by superadmin`);
    return successResponse(res, 200, null, 'Plan deactivated');
  } catch (error) {
    logger.error('Error in deletePlan:', error);
    next(error);
  }
};

module.exports = {
  getBusinesses,
  getBusinessById,
  toggleBusiness,
  deleteBusiness,
  changeBusinessPlan,
  extendSubscription,
  grantSubscription,
  getSubscriptionHistory,
  getBusinessFlowSnapshots,
  grantPreviewCredits,
  getPlatformStats,
  getRevenueReport,
  getPlans,
  createPlan,
  updatePlan,
  deletePlan
};
