const supabase = require('../config/supabase');
const logger = require('../utils/logger');

// 'lost' is deliberately excluded — manual-only exit state for this phase
// (see the customers_pipeline_stage migration). Ranked stages only, used to
// decide whether an automatic transition is forward progress.
const STAGE_RANK = { new: 0, contacted: 1, converted: 2 };

/**
 * Moves a customer's pipeline_stage forward to targetStage if — and only
 * if — that's real forward progress: never fires while the customer is
 * 'lost' (manual-only exit, never auto-revived) and never moves a stage
 * backward (targetStage's rank must exceed the current stage's rank). This
 * is why Contacted->Converted can land directly from 'new': a fully
 * bot-driven booking with no staff reply in between is still forward
 * progress from 'new', just skipping a stage it never passed through.
 *
 * Call sites: message.controller.js#sendMessage ('contacted', on a human
 * staff reply), booking.controller.js#updateBookingStatus and
 * payment.service.js#handlePaymentLinkPaid ('converted', on a booking
 * reaching confirmed/completed) — the two places a booking can reach that
 * status.
 *
 * Swallows its own errors (logs instead of throwing) — this is a side
 * effect of a primary action (sending a message, confirming a booking) and
 * must never fail that action.
 *
 * @param {string} customerId
 * @param {'contacted'|'converted'} targetStage
 */
const advancePipelineStage = async (customerId, targetStage) => {
  try {
    const { data: customer, error: findErr } = await supabase
      .from('customers').select('pipeline_stage').eq('id', customerId).maybeSingle();
    if (findErr) throw findErr;
    if (!customer) return;

    const currentStage = customer.pipeline_stage;
    if (currentStage === 'lost') return;
    if (STAGE_RANK[targetStage] <= STAGE_RANK[currentStage]) return;

    // Guard the write on the stage we read — if it changed underneath us
    // (e.g. a concurrent manual override), this update becomes a no-op
    // instead of clobbering it.
    const { error: updateErr } = await supabase
      .from('customers').update({ pipeline_stage: targetStage })
      .eq('id', customerId).eq('pipeline_stage', currentStage);
    if (updateErr) throw updateErr;
  } catch (error) {
    logger.error('Error advancing pipeline stage:', { customerId, targetStage, error });
  }
};

module.exports = { advancePipelineStage };
