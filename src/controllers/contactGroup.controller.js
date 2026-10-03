const contactGroupService = require('../services/contactGroup.service');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

// Services return { status, error } for problems the owner can fix.
const send = (res, result, okStatus = 200, message) => (result && result.error
  ? errorResponse(res, result.status, result.error)
  : successResponse(res, okStatus, result, message));

/** GET /api/contacts/groups — every group A→Z: { id, name, memberCount, createdAt, updatedAt }. */
const listGroups = async (req, res, next) => {
  try {
    return send(res, await contactGroupService.list(req.user.businessId));
  } catch (error) {
    logger.error('Error in listGroups:', error);
    next(error);
  }
};

/** POST /api/contacts/groups — Body { name }. */
const createGroup = async (req, res, next) => {
  try {
    return send(res, await contactGroupService.create(req.user.businessId, req.user.userId, req.body), 201, 'Group created');
  } catch (error) {
    logger.error('Error in createGroup:', error);
    next(error);
  }
};

/** PUT /api/contacts/groups/:id — Body { name }. */
const renameGroup = async (req, res, next) => {
  try {
    return send(res, await contactGroupService.rename(req.user.businessId, req.params.id, req.body), 200, 'Group saved');
  } catch (error) {
    logger.error('Error in renameGroup:', error);
    next(error);
  }
};

/** DELETE /api/contacts/groups/:id — the group and its memberships; customers stay. */
const deleteGroup = async (req, res, next) => {
  try {
    return send(res, await contactGroupService.remove(req.user.businessId, req.params.id), 200, 'Group deleted');
  } catch (error) {
    logger.error('Error in deleteGroup:', error);
    next(error);
  }
};

/** POST /api/contacts/groups/:id/members — Body { customerIds } (≤ 500). */
const addGroupMembers = async (req, res, next) => {
  try {
    return send(res, await contactGroupService.addMembers(req.user.businessId, req.params.id, req.body));
  } catch (error) {
    logger.error('Error in addGroupMembers:', error);
    next(error);
  }
};

/** POST /api/contacts/groups/:id/members/remove — Body { customerIds } (≤ 500). */
const removeGroupMembers = async (req, res, next) => {
  try {
    return send(res, await contactGroupService.removeMembers(req.user.businessId, req.params.id, req.body));
  } catch (error) {
    logger.error('Error in removeGroupMembers:', error);
    next(error);
  }
};

module.exports = {
  listGroups,
  createGroup,
  renameGroup,
  deleteGroup,
  addGroupMembers,
  removeGroupMembers
};
