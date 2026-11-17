// Run: node --test src/utils/noPurchaseWording.guard.test.js
// The Android app must not sell or steer to purchases (Google Play payments policy), so the server texts it
// shows (API errors + push texts) state a limit without "upgrade", "buy", "renew", "subscribe" or a link.
// This scans the files that own those texts: any non-comment line there that carries a message must not
// contain that wording, in English or in the Hindi/Marathi push translations.
// Deliberately NOT scanned: email.service.js and subscriptionNotifications.service.js (owner email/WhatsApp
// payment texts, out of scope), and subscription/payment code where "renew" is a column or route name.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FILES = [
  'controllers/staff.controller.js',
  'middleware/plan.middleware.js',
  'services/businessMedia.service.js',
  'services/catalogMedia.service.js',
  'services/catalogCollection.service.js',
  'services/broadcastCap.service.js',
  'services/replyMedia.service.js',
  'services/notification.service.js'
];

const FORBIDDEN = /upgrade|\bbuy\b|renew|subscribe|अपग्रेड|रिन्यू|नवीनीकरण|खरीद|खरेदी|सब्सक्राइब|सबस्क्राइब/i;
const isComment = (line) => /^\s*(\/\/|\/\*|\*)/.test(line);

test('app-facing server texts carry no upgrade/buy/renew/subscribe wording', () => {
  const offenders = [];
  for (const rel of FILES) {
    fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').split('\n').forEach((line, i) => {
      if (!isComment(line) && FORBIDDEN.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('the push texts for plan/usage keep en, hi and mr', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services/notification.service.js'), 'utf8');
  for (const type of ['usage_100', 'plan_expiring', 'plan_expired']) {
    const block = src.slice(src.indexOf(`  ${type}: {`), src.indexOf('  },', src.indexOf(`  ${type}: {`)) + 4);
    assert.match(block, /body: \{[\s\S]*en:[\s\S]*hi:[\s\S]*mr:/, `${type} has en/hi/mr bodies`);
  }
});
