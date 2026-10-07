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
const courseCatalogRoutes = require('./routes/courseCatalog.routes');
const categoryFeatureRoutes = require('./routes/categoryFeature.routes');
const botSettingsRoutes = require('./routes/botSettings.routes');
const courseRoutes = require('./routes/course.routes');
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
const businessCategoryTemplateRoutes = require('./routes/businessCategoryTemplate.routes');
const nodeLibraryRoutes = require('./routes/nodeLibrary.routes');
const nodeLibraryPublicRoutes = require('./routes/nodeLibraryPublic.routes');
const reportsRoutes = require('./routes/reports.routes');
const followupRoutes = require('./routes/followup.routes');
const optInLinkRoutes = require('./routes/optInLink.routes');
const contactImportRoutes = require('./routes/contactImport.routes');
const contactGroupRoutes = require('./routes/contactGroup.routes');

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
// Broadcast bodies can carry up to 2,000 customer ids (~80 KB with the rest of
// the form), more than the 100 KB default. Mounted BEFORE the global parser,
// which skips a request this one already read; every other route keeps the
// default limit.
app.use('/api/broadcasts', express.json({ limit: '1mb' }));
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
// Super Admin course catalog (coaching) — always mounted (superadmin only),
// like vehicle-catalog above; must stay above the /api/admin catch-all.
app.use('/api/admin/course-catalog', courseCatalogRoutes);
// Super Admin feature switches per category (e.g. coaching → bot_builder).
app.use('/api/admin/category-features', categoryFeatureRoutes);
app.use('/api/admin/rate-cards', rateCardRoutes);
app.use('/api/admin/category-templates', categoryTemplateRoutes);
app.use('/api/admin/whatsapp-flows', whatsappFlowRoutes);
app.use('/api/admin/business-categories', businessCategoryAdminRoutes);
app.use('/api/admin/business-category-templates', businessCategoryTemplateRoutes);
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
// AI flow generation (Phase 1) — mounted only when ENABLE_AI_FLOW_GEN=true;
// required inside the branch so the module isn't even loaded when off.
// Must stay above the /api/flow-graph catch-all, like the mounts above.
if (config.ENABLE_AI_FLOW_GEN) {
  app.use('/api/flow-graph/ai', require('./routes/aiFlow.routes'));
}
app.use('/api/flow-graph', flowGraphRoutes);
// Settings-driven bot builder + a business's own courses. Always mounted;
// each request is gated by the business category's 'bot_builder' switch
// (Super Admin → Business Settings → <category> → Features — see
// middleware/categoryFeature.middleware.js), 404 while it's off.
app.use('/api/bot-settings', botSettingsRoutes);
app.use('/api/courses', courseRoutes);
app.use('/api/reports', reportsRoutes);
// Follow-up automations. Always mounted; each request is gated by the
// 'followups' switch (category or per-business, Super Admin → Features),
// 404 while it's off. Sending is the sweeper (server.js).
app.use('/api/followups', followupRoutes);
// Opt-in links (wa.me link / QR poster → consent buttons). Always mounted;
// each request is gated by the 'opt_in_links' switch, 404 while it's off.
app.use('/api/opt-in-links', optInLinkRoutes);
// Contact import (CSV / XLSX / Google Sheet) + customer groups. Always
// mounted; each request is gated by the 'contact_import' switch, 404 while
// it's off.
app.use('/api/contacts/import', contactImportRoutes);
app.use('/api/contacts/groups', contactGroupRoutes);

// Error handler middleware
app.use(errorHandler);

module.exports = app;
