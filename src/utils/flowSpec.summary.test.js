// Run: node --test src/utils/flowSpec.summary.test.js
// Regression test: a compiled booking's confirmation summary must not
// include booking.intro. Uses the REAL booking.service.js#
// buildBookingSummaryBody (pure) — the modules booking.service.js requires
// that open Redis/Supabase/BullMQ/socket.io connections at load time are
// stubbed in require.cache first. node --test runs each test file in its
// own process, so these stubs never leak into other test files.
const path = require('path');

const stub = (relativePath, exports) => {
  const resolved = require.resolve(path.join(__dirname, relativePath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
stub('../config/redis', {});
stub('../config/supabase', {});
stub('../queues/whatsapp.queue', { addToWhatsappQueue: async () => {} });
stub('../queues/sessionTimeout.queue', { addToSessionTimeoutQueue: async () => {} });
stub('../services/socket.service', {});
stub('../services/payment.service', {});
stub('../services/distanceMatrix.service', {});

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBookingSummaryBody } = require('../services/booking.service');
const { compileFlowSpec } = require('./flowSpec');

const spec = (field1Overrides = {}) => ({
  version: 1,
  greeting: { text: 'Welcome!' },
  menu: [{ id: 'book', title: 'Book now', action: { type: 'booking' } }],
  booking: {
    keyword: 'book',
    intro: "Let's book your visit.",
    fields: [
      { key: 'patientName', label: 'Patient name', type: 'text', ...field1Overrides },
      { key: 'visitType', label: 'Visit type?', type: 'choice', options: [{ value: 'New', label: 'New' }, { value: 'Old', label: 'Old' }] }
    ]
  }
});

// Mirrors exactly what bookingGraph.service.js#advanceGraphSession records
// per answered question node: { fieldKey, label: node.label, summaryLabel: node.summaryLabel }.
const answeredFieldsFor = (questionNodes) =>
  questionNodes.map(n => ({ fieldKey: n.fieldKey, label: n.label, summaryLabel: n.summaryLabel }));

test('intro set, no summaryLabel on field 1 -> confirmation line is "Patient name: *Ravi*"', () => {
  const { questionNodes } = compileFlowSpec(spec());
  assert.equal(questionNodes[0].label, "Let's book your visit.\n\nPatient name", 'customer still sees the intro in the question');
  const body = buildBookingSummaryBody({ patientName: 'Ravi', visitType: 'New' }, answeredFieldsFor(questionNodes), false);
  assert.equal(body, 'Patient name: *Ravi*\nVisit type: *New*');
  assert.ok(!body.includes("Let's book your visit."));
});

test('explicit summaryLabel still wins', () => {
  const { questionNodes } = compileFlowSpec(spec({ summaryLabel: 'Name' }));
  const body = buildBookingSummaryBody({ patientName: 'Ravi' }, answeredFieldsFor(questionNodes), false);
  assert.equal(body, 'Name: *Ravi*');
});

test('trailing question marks are dropped from the derived summaryLabel', () => {
  const { questionNodes } = compileFlowSpec(spec({ label: 'Patient name??' }));
  assert.equal(questionNodes[0].summaryLabel, 'Patient name');
  assert.equal(questionNodes[1].summaryLabel, 'Visit type');
});
