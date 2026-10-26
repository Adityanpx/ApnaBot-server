// src/services/email.service.js — CREATE THIS FILE

const { BrevoClient } = require('@getbrevo/brevo');
const logger = require('../utils/logger');

const brevo = new BrevoClient({ apiKey: process.env.BREVO_API_KEY });

const sendEmail = async ({ to, subject, html }) => {
  return brevo.transactionalEmails.sendTransacEmail({
    subject,
    htmlContent: html,
    sender: { email: process.env.EMAIL_SENDER_ADDRESS || 'averixsolutions09@gmail.com', name: 'ApnaBot' },
    to: [{ email: to }]
  });
};

/**
 * Send password reset email
 * @param {string} toEmail - Recipient email
 * @param {string} resetToken - The reset token
 * @param {string} userName - Recipient name
 */
const sendPasswordResetEmail = async (toEmail, resetToken, userName) => {
  try {
    const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}&email=${toEmail}`;

    await sendEmail({
      to: toEmail,
      subject: 'Reset your ApnaBot password',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1a1a2e;">Password Reset Request</h2>
          <p>Hi ${userName},</p>
          <p>We received a request to reset your ApnaBot password.</p>
          <p>Click the button below to reset it. This link expires in <strong>1 hour</strong>.</p>
          <a href="${resetUrl}"
             style="display: inline-block; background: #1a1a2e; color: white;
                    padding: 12px 24px; border-radius: 6px; text-decoration: none;
                    margin: 16px 0;">
            Reset Password
          </a>
          <p style="color: #777; font-size: 13px;">
            If you did not request this, ignore this email. Your password will not change.
          </p>
          <p style="color: #777; font-size: 13px;">
            Or copy this link: ${resetUrl}
          </p>
        </div>
      `
    });

    logger.info(`Password reset email sent to ${toEmail}`);
  } catch (error) {
    logger.error('Error sending password reset email:', error);
    throw error;
  }
};

/**
 * Send email verification OTP
 * @param {string} toEmail - Recipient email
 * @param {string} otp - The 6-digit OTP
 * @param {string} userName - Recipient name
 */
const sendVerificationEmail = async (toEmail, otp, userName) => {
  try {
    await sendEmail({
      to: toEmail,
      subject: 'Verify your ApnaBot email',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1a1a2e;">Verify Your Email</h2>
          <p>Hi ${userName},</p>
          <p>Use the code below to verify your ApnaBot email address. This code expires in <strong>10 minutes</strong>.</p>
          <p style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #1a1a2e; margin: 16px 0;">
            ${otp}
          </p>
          <p style="color: #777; font-size: 13px;">
            If you did not request this, ignore this email.
          </p>
        </div>
      `
    });

    logger.info(`Verification email sent to ${toEmail}`);
  } catch (error) {
    logger.error('Error sending verification email:', error);
    throw error;
  }
};

/**
 * Send subscription expiry warning email
 * @param {string} toEmail
 * @param {string} businessName
 * @param {Date} expiryDate
 */
const sendExpiryWarningEmail = async (toEmail, businessName, expiryDate) => {
  try {
    await sendEmail({
      to: toEmail,
      subject: `Your ApnaBot subscription for ${businessName} is expiring soon`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1a1a2e;">Subscription Expiring Soon</h2>
          <p>Hi,</p>
          <p>Your ApnaBot subscription for <strong>${businessName}</strong> will expire on
             <strong>${expiryDate.toDateString()}</strong>.</p>
          <p>Renew now to keep your WhatsApp chatbot running without interruption.</p>
          <a href="${process.env.FRONTEND_URL}/billing"
             style="display: inline-block; background: #1a1a2e; color: white;
                    padding: 12px 24px; border-radius: 6px; text-decoration: none;
                    margin: 16px 0;">
            Renew Subscription
          </a>
        </div>
      `
    });

    logger.info(`Expiry warning email sent to ${toEmail} for business ${businessName}`);
  } catch (error) {
    logger.error('Error sending expiry warning email:', error);
    // Don't throw — email failure should not crash the app
  }
};

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/**
 * Tell the Averix team an owner signed up for a kind of business that is not in the category list.
 * Every value is owner-typed, so it is HTML-escaped. One mail per recipient; a failure for one
 * recipient does not stop the others. Never throws.
 * @param {string[]} toEmails
 * @param {{ businessName: string, requestedText: string, contactPhone: string, ownerName: string, ownerEmail: string }} details
 * @returns {Promise<number>} how many mails were sent
 */
const sendBusinessRequestEmail = async (toEmails, details) => {
  let sent = 0;
  const { businessName, requestedText, contactPhone, ownerName, ownerEmail } = details;
  for (const to of toEmails) {
    try {
      await sendEmail({
        to,
        subject: `New business request: ${String(requestedText).slice(0, 60)}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #1a1a2e;">New business request</h2>
            <p>An owner signed up for a kind of business that is not in the category list.</p>
            <p><strong>Requested:</strong> ${escapeHtml(requestedText)}</p>
            <p><strong>Business:</strong> ${escapeHtml(businessName)}</p>
            <p><strong>Contact phone:</strong> ${escapeHtml(contactPhone)}</p>
            <p><strong>Owner:</strong> ${escapeHtml(ownerName)} (${escapeHtml(ownerEmail)})</p>
            <p style="color: #777; font-size: 13px;">
              They are on the General category for now. Open Super Admin, Business Requests.
            </p>
          </div>
        `
      });
      sent += 1;
    } catch (error) {
      logger.error(`Error sending business request email to ${to}:`, error);
    }
  }
  return sent;
};

module.exports = {
  sendPasswordResetEmail,
  sendVerificationEmail,
  sendExpiryWarningEmail,
  sendBusinessRequestEmail
};
