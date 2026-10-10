const { cleanValue, fillPlaceholders } = require('./templateValue');

function applyMessageTemplate(text, business, customer) {
  if (!text) return text;
  return fillPlaceholders(text, {
    businessName: cleanValue(business.displayName) || cleanValue(business.name),
    customerName: cleanValue(customer?.name) || 'there',
    businessAddress: cleanValue(business.address, { multiline: true }),
    businessHours: cleanValue(business.businessHours, { multiline: true })
  }, { clean: false });
}

function applyMessageTemplateWithFooter(text, business, customer) {
  const result = applyMessageTemplate(text, business, customer);
  if (result && business.footerMessage) {
    return `${result}\n\n${business.footerMessage}`;
  }
  return result;
}

module.exports = { applyMessageTemplate, applyMessageTemplateWithFooter };
