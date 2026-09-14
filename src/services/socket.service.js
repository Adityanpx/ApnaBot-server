const { Server } = require('socket.io');
const config = require('../config/env');
const authService = require('./auth.service');
const supabase = require('../config/supabase');
const logger = require('../utils/logger');

let io = null;

// socket.id -> Set<customerId> currently being viewed by that staff socket
// In-memory only, by design: presence doesn't need to survive a restart.
const viewingBySocket = new Map();

/**
 * Initialize Socket.io with the HTTP server
 * @param {http.Server} httpServer - The Node.js HTTP server instance
 */
const initialize = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: [config.FRONTEND_URL, config.ADMIN_URL],
      methods: ['GET', 'POST']
    }
  });

  // Socket.io authentication middleware
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      
      if (!token) {
        return next(new Error('Authentication required'));
      }

      // Verify the token
      const decoded = await authService.verifyAccessToken(token);
      
      if (!decoded) {
        return next(new Error('Invalid token'));
      }

      // Attach user info to socket
      socket.user = {
        userId: decoded.userId,
        businessId: decoded.businessId,
        role: decoded.role,
        name: null
      };

      // JWT payload doesn't carry name; fetch it once per connection for presence display
      if (decoded.userId) {
        try {
          const { data: user } = await supabase
            .from('users').select('name').eq('id', decoded.userId).maybeSingle();
          socket.user.name = user?.name || null;
        } catch (err) {
          logger.error('Failed to fetch user name for socket presence:', err);
        }
      }

      next();
    } catch (error) {
      logger.error('Socket authentication error:', error);
      next(new Error('Authentication failed'));
    }
  });

  // Handle socket connections
  io.on('connection', (socket) => {
    const { userId, businessId, role } = socket.user;

    if (role === 'superadmin') {
      socket.join('admin');
      logger.info(`Super admin ${userId} connected to socket`);
    } else if (businessId) {
      socket.join(`business:${businessId}`);
      logger.info(`Business ${businessId} connected to socket`);
    }

    socket.on('conversation:viewing:start', ({ customerId } = {}) => {
      if (!businessId || !customerId) return;
      if (!viewingBySocket.has(socket.id)) viewingBySocket.set(socket.id, new Set());
      viewingBySocket.get(socket.id).add(customerId);
      emitToBusiness(businessId, 'conversation:viewer:joined', {
        customerId,
        staffId: userId,
        staffName: socket.user.name
      });
    });

    socket.on('conversation:viewing:stop', ({ customerId } = {}) => {
      if (!businessId || !customerId) return;
      viewingBySocket.get(socket.id)?.delete(customerId);
      emitToBusiness(businessId, 'conversation:viewer:left', {
        customerId,
        staffId: userId,
        staffName: socket.user.name
      });
    });

    socket.on('disconnect', () => {
      logger.info(`Socket disconnected: ${socket.id}`);
      const viewing = viewingBySocket.get(socket.id);
      if (viewing && businessId) {
        for (const customerId of viewing) {
          emitToBusiness(businessId, 'conversation:viewer:left', {
            customerId,
            staffId: userId,
            staffName: socket.user.name
          });
        }
      }
      viewingBySocket.delete(socket.id);
    });
  });

  logger.info('Socket.io initialized');
  return io;
};

/**
 * Emit an event to a specific business's room
 * @param {string} businessId - The business ID
 * @param {string} event - The event name
 * @param {any} data - The data to emit
 */
const emitToBusiness = (businessId, event, data) => {
  if (!io) {
    logger.warn('Socket.io not initialized, cannot emit to business');
    return;
  }
  io.to(`business:${businessId}`).emit(event, data);
};

/**
 * Emit an event to the admin room
 * @param {string} event - The event name
 * @param {any} data - The data to emit
 */
const emitToAdmin = (event, data) => {
  if (!io) {
    logger.warn('Socket.io not initialized, cannot emit to admin');
    return;
  }
  io.to('admin').emit(event, data);
};

/**
 * Get the Socket.io instance
 * @returns {Server|null} The Socket.io instance
 */
const getIO = () => {
  return io;
};

module.exports = {
  initialize,
  emitToBusiness,
  emitToAdmin,
  getIO
};
