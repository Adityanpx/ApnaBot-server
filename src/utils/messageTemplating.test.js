// Run: node --test src/utils/messageTemplating.test.js
// applyMessageTemplate must not change any message whose values are clean: the
// pre-change function is kept below, verbatim, as the oracle.
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyMessageTemplate, applyMessageTemplateWithFooter } = require('./messageTemplating');

function legacyApplyMessageTemplate(text, business, customer) {
  if (!text) return text;
  let result = text.replace(/\{\{businessName\}\}/g, business.displayName || business.name || '');
  result = result.replace(/\{\{customerName\}\}/g, (customer?.name || '').trim() || 'there');
  result = result.replace(/\{\{businessAddress\}\}/g, business.address || '');
  result = result.replace(/\{\{businessHours\}\}/g, business.businessHours || '');
  return result;
}

const clean = { displayName: 'PrimeCare Health Clinic', name: 'PrimeCare', address: '12 MG Road, Pune', businessHours: 'Mon-Sat 9-6\nSun closed' };

test('clean values: output is byte-identical to the old function', () => {
  const texts = [
    'welcome to *{{businessName}}*.',
    'Hello *{{customerName}}*, welcome to *{{businessName}}*!\n\nPlease choose an option:',
    'Visit us: {{businessAddress}}\nOpen: {{businessHours}}',
    '{{businessName}} {{businessName}} {{customerName}} {{unknown}} {{ businessName }}',
    'no variables here',
    'नमस्ते {{customerName}}, {{businessName}} में स्वागत है'
  ];
  const customers = [{ name: 'Asha' }, { name: 'Asha Patil' }, { name: '' }, { name: null }, null, undefined];
  const businesses = [clean, { ...clean, displayName: null }, { ...clean, displayName: '', name: 'Fallback Co' }, { name: 'Only Name' }];
  for (const text of texts) {
    for (const customer of customers) {
      for (const business of businesses) {
        assert.equal(applyMessageTemplate(text, business, customer), legacyApplyMessageTemplate(text, business, customer));
      }
    }
  }
  assert.equal(applyMessageTemplate('', clean, null), '');
  assert.equal(applyMessageTemplate(null, clean, null), null);
});

test('trailing space on businessName: the bold stays intact', () => {
  const out = applyMessageTemplate('welcome to *{{businessName}}*.', { displayName: 'PrimeCare Health Clinic ' }, null);
  assert.equal(out, 'welcome to *PrimeCare Health Clinic*.');
});

test('leading space on businessName', () => {
  assert.equal(applyMessageTemplate('*{{businessName}}*', { displayName: '  PrimeCare' }, null), '*PrimeCare*');
});

test('trailing and leading spaces on customerName', () => {
  assert.equal(applyMessageTemplate('Hello *{{customerName}}*', clean, { name: ' Asha ' }), 'Hello *Asha*');
});

test('a newline or tab inside a name becomes one space', () => {
  assert.equal(applyMessageTemplate('*{{businessName}}*', { displayName: 'Prime\nCare\tClinic' }, null), '*Prime Care Clinic*');
  assert.equal(applyMessageTemplate('*{{customerName}}*', clean, { name: 'Asha\n  Patil' }), '*Asha Patil*');
});

test('several variables in one string are all cleaned', () => {
  const out = applyMessageTemplate(
    'Hello *{{customerName}}*, welcome to *{{businessName}}*! {{businessAddress}}',
    { displayName: 'PrimeCare ', address: ' 12 MG Road ' },
    { name: ' Asha ' }
  );
  assert.equal(out, 'Hello *Asha*, welcome to *PrimeCare*! 12 MG Road');
});

test('empty values: customerName reads there, the business values read empty', () => {
  assert.equal(applyMessageTemplate('Hi {{customerName}}', clean, { name: '' }), 'Hi there');
  assert.equal(applyMessageTemplate('Hi {{customerName}}', clean, { name: '   ' }), 'Hi there'); // only spaces
  assert.equal(applyMessageTemplate('Hi {{customerName}}', clean, null), 'Hi there');
  assert.equal(applyMessageTemplate('[{{businessAddress}}]', { name: 'X' }, null), '[]');
  assert.equal(applyMessageTemplate('[{{businessHours}}]', { name: 'X', businessHours: '  ' }, null), '[]');
});

test('a whitespace-only displayName falls back to the name', () => {
  assert.equal(applyMessageTemplate('{{businessName}}', { displayName: '   ', name: 'Fallback Co ' }, null), 'Fallback Co');
});

test('address and hours keep their inner line breaks, ends are trimmed', () => {
  const out = applyMessageTemplate('{{businessHours}}|{{businessAddress}}', { name: 'X', businessHours: '\nMon-Sat 9-6\nSun closed \n', address: ' Line 1\nLine 2 ' }, null);
  assert.equal(out, 'Mon-Sat 9-6\nSun closed|Line 1\nLine 2');
});

test('translated text goes through the same cleaning', () => {
  assert.equal(
    applyMessageTemplate('नमस्ते *{{customerName}}*, *{{businessName}}* में स्वागत है', { displayName: 'प्राइमकेयर ' }, { name: ' आशा ' }),
    'नमस्ते *आशा*, *प्राइमकेयर* में स्वागत है'
  );
});

test('a value with $ patterns or a mark inside it is used literally', () => {
  assert.equal(applyMessageTemplate('{{businessName}}', { displayName: 'Cash $& Carry $1' }, null), 'Cash $& Carry $1');
  assert.equal(applyMessageTemplate('{{customerName}} / {{businessName}}', { displayName: 'Biz' }, { name: '{{businessName}}' }), '{{businessName}} / Biz');
});

test('the footer is appended unchanged after the cleaned text', () => {
  assert.equal(
    applyMessageTemplateWithFooter('Hi *{{customerName}}*', { footerMessage: 'Thanks!' }, { name: ' Asha ' }),
    'Hi *Asha*\n\nThanks!'
  );
});
