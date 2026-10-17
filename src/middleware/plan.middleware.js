const { getCurrentSubscriptionRow } = require('../services/currentSubscription.service');
const { errorResponse } = require('../utils/response');
const redis = require('../config/redis');

const requireFeature = (featureName) => {
  return async (req, res, next) => {
    // Superadmin bypasses plan check
    if (req.user.role === 'superadmin') {
      return next();
    }

    try {
      const businessId = req.user.businessId;
      const cacheKey = `subscription:${businessId}`;

      // Try to get from cache first
      let subscription = await redis.get(cacheKey);

      if (subscription) {
        subscription = JSON.parse(subscription);
      } else {
        // Query DB if not in cache
        const { data, error } = await getCurrentSubscriptionRow(businessId, { statuses: ['active', 'trial'] });
        if (error) throw error;
        subscription = data;

        if (subscription) {
          // Cache for 5 minutes
          await redis.set(cacheKey, JSON.stringify(subscription), 'EX', 300);
        }
      }

      // Check if subscription exists and is active
      if (!subscription || !['active', 'trial'].includes(subscription.status)) {
        return errorResponse(res, 403, 'No active subscription. Please subscribe to continue.');
      }

      // Get the plan
      const plan = subscription.plan;

      // Check if feature is enabled
      let featureEnabled = false;
      switch (featureName) {
        case 'paymentLink':
          featureEnabled = plan.payment_link_enabled;
          break;
        case 'staff':
          featureEnabled = plan.staff_enabled;
          break;
        case 'booking':
          featureEnabled = plan.booking_enabled;
          break;
        default:
          featureEnabled = false;
      }

      if (!featureEnabled) {
        return errorResponse(res, 403, 'This feature is not available on your current plan. Please upgrade.');
      }

      // Attach subscription to req
      req.subscription = {
        plan,
        subscription
      };

      next();
    } catch (error) {
      next(error);
    }
  };
};

module.exports = { requireFeature };
