const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const config = require('./config/env');
const { globalLimiter } = require('./middleware/rateLimiter.middleware');
const errorHandler = require('./middleware/errorHandler.middleware');

// Import routes
const authRoutes = require('./routes/auth.routes');
const businessRoutes = require('./routes/business.routes');
const customerRoutes = require('./routes/customer.routes');
const messageRoutes = require('./routes/message.routes');
const bookingRoutes = require('./routes/booking.routes');
const webhookRoutes = require('./routes/webhook.routes');
const paymentRoutes = require('./routes/payment.routes');
const subscriptionRoutes = require('./routes/subscription.routes');
const staffRoutes = require('./routes/staff.routes');
const adminRoutes = require('./routes/admin.routes');
const publicRoutes = require('./routes/public.routes');
const vehicleCatalogRoutes = require('./routes/vehicleCatalog.routes');
const vehicleRoutes = require('./routes/vehicle.routes');
const routeFareRoutes = require('./routes/routeFare.routes');
const rentalPackageRoutes = require('./routes/rentalPackage.routes');
const messageTemplateRoutes = require('./routes/messageTemplate.routes');
const broadcastRoutes = require('./routes/broadcast.routes');
const walletRoutes = require('./routes/wallet.routes');
const rateCardRoutes = require('./routes/rateCard.routes');
const flowGraphRoutes = require('./routes/flowGraph.routes');
const flowGraphPreviewRoutes = require('./routes/flowGraphPreview.routes');
const flowSnapshotRoutes = require('./routes/flowSnapshot.routes');
const categoryTemplateRoutes = require('./routes/categoryTemplate.routes');
const whatsappFlowRoutes = require('./routes/whatsappFlow.routes');
const businessCategoryRoutes = require('./routes/businessCategory.routes');
const businessCategoryAdminRoutes = require('./routes/businessCategoryAdmin.routes');
const nodeLibraryRoutes = require('./routes/nodeLibrary.routes');
const nodeLibraryPublicRoutes = require('./routes/nodeLibraryPublic.routes');
const reportsRoutes = require('./routes/reports.routes');

const app = express();

// Trust the first proxy hop (required on Render to avoid ERR_ERL_UNEXPECTED_X_FORWARDED_FOR)
app.set('trust proxy', 1);

// Middlewares
// CSP is relaxed (beyond helmet defaults) to allow the Facebook JS SDK to load
// and run on the static WhatsApp Embedded Signup page served from /public.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'script-src': ["'self'", "'unsafe-inline'", 'https://connect.facebook.net'],
      'connect-src': ["'self'", 'https://graph.facebook.com', 'https://*.facebook.com'],
      'frame-src': ["'self'", 'https://*.facebook.com', 'https://web.facebook.com']
    }
  }
}));
app.use(cors({
  origin: [config.FRONTEND_URL, config.ADMIN_URL, ...config.WEB_APP_URLS].filter(Boolean)
}));
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true }));

// Serve static assets (e.g. the WhatsApp Embedded Signup page loaded in the app's WebView)
app.use(express.static(path.join(__dirname, '../public')));

// Apply global rate limiter to all routes except /api/webhook
app.use((req, res, next) => {
  if (req.path.startsWith('/api/webhook')) return next();
  return globalLimiter(req, res, next);
});

// Health check route
app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Server is running',
    timestamp: new Date()
  });
});

// Root route - API info
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'ApnaBot API is running',
    frontend: config.FRONTEND_URL,
    admin: config.ADMIN_URL,
    docs: '/health'
  });
});

// Mount routes
app.use('/api/auth', authRoutes);
app.use('/api/business', businessRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/subscription', subscriptionRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/admin/vehicle-catalog', vehicleCatalogRoutes);
app.use('/api/admin/rate-cards', rateCardRoutes);
app.use('/api/admin/category-templates', categoryTemplateRoutes);
app.use('/api/admin/whatsapp-flows', whatsappFlowRoutes);
app.use('/api/admin/business-categories', businessCategoryAdminRoutes);
app.use('/api/business-categories', businessCategoryRoutes);
app.use('/api/admin/node-library', nodeLibraryRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/route-fares', routeFareRoutes);
app.use('/api/rental-packages', rentalPackageRoutes);
app.use('/api/message-templates', messageTemplateRoutes);
app.use('/api/broadcasts', broadcastRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/flow-graph/snapshots', flowSnapshotRoutes);
app.use('/api/flow-graph/library', nodeLibraryPublicRoutes);
app.use('/api/flow-graph/preview', flowGraphPreviewRoutes);
app.use('/api/flow-graph', flowGraphRoutes);
app.use('/api/reports', reportsRoutes);

// Error handler middleware
app.use(errorHandler);

module.exports = app;
