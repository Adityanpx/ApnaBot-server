// Run: node --test src/controllers/businessCategoryAdmin.controller.test.js
// Super Admin creates / edits business categories as plain business_categories rows (no migration, no deploy).
// The real controller and service run against the in-memory Supabase from test-support; emoji and
// labelTranslations must come back camelCased from both the admin list and the public signup list.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
const service = require('../services/businessCategory.service');
const controller = require('./businessCategoryAdmin.controller');
const publicController = require('./businessCategory.controller');

let db;
test.beforeEach(() => {
  db = h.reset();
  db.business_categories = [
    { value: 'general', label: 'General', icon: 'briefcase', emoji: '', label_translations: {}, is_enabled: true, display_order: 80 },
    { value: 'hotel', label: 'Hotel', icon: '🏨', emoji: '', label_translations: {}, is_enabled: true, display_order: 230 }
  ];
});

const call = async (handler, { params = {}, body = {} } = {}) => {
  const out = {};
  const res = { status: (code) => { out.status = code; return res; }, json: (payload) => { out.body = payload; return res; } };
  await handler({ params, body, query: {} }, res, (err) => { throw err; });
  return out;
};
const create = (body) => call(controller.createCategory, { body });
const update = (value, body) => call(controller.updateCategory, { params: { value }, body });
const valid = { value: 'mobile_electronics', label: 'Mobile & Electronics' };

test('create: a minimal body makes a disabled category after the last display order', async () => {
  const { status, body } = await create(valid);
  assert.equal(status, 201);
  assert.deepEqual(
    [body.data.value, body.data.label, body.data.isEnabled, body.data.displayOrder],
    ['mobile_electronics', 'Mobile & Electronics', false, 240]
  );
  const row = db.business_categories.find((r) => r.value === 'mobile_electronics');
  assert.equal(row.is_enabled, false, 'never shows at signup until enabled');
  assert.equal(row.display_order, 240);
});

test('create: every field is stored, trimmed, and returned camelCased', async () => {
  const { status, body } = await create({
    ...valid, label: '  Mobile & Electronics ', emoji: '📱', icon: 'smartphone', displayOrder: 158, isEnabled: true,
    labelTranslations: { hi: 'मोबाइल और इलेक्ट्रॉनिक्स', mr: 'मोबाइल आणि इलेक्ट्रॉनिक्स' }
  });
  assert.equal(status, 201);
  const row = db.business_categories.find((r) => r.value === 'mobile_electronics');
  assert.deepEqual(
    { label: row.label, emoji: row.emoji, icon: row.icon, display_order: row.display_order, is_enabled: row.is_enabled, label_translations: row.label_translations },
    { label: 'Mobile & Electronics', emoji: '📱', icon: 'smartphone', display_order: 158, is_enabled: true,
      label_translations: { hi: 'मोबाइल और इलेक्ट्रॉनिक्स', mr: 'मोबाइल आणि इलेक्ट्रॉनिक्स' } }
  );
  assert.equal(body.data.emoji, '📱');
  assert.deepEqual(body.data.labelTranslations, row.label_translations);
  assert.equal(body.data.displayOrder, 158);
});

test('create: value must be 3-40 chars, lowercase letters/digits/underscore, starting with a letter', async () => {
  for (const value of [undefined, 42, '', 'ab', '1abc', '_abc', 'Abc', 'mobile-electronics', 'mobile electronics', 'a'.repeat(41)]) {
    const { status } = await create({ ...valid, value });
    assert.equal(status, 400, `rejects ${JSON.stringify(value)}`);
  }
  for (const value of ['abc', 'a'.repeat(40), 'shop_2']) {
    assert.equal((await create({ ...valid, value })).status, 201, `accepts ${value}`);
  }
});

test('create: a value that already exists is a 409 and the stored row is untouched', async () => {
  const { status, body } = await create({ value: 'general', label: 'Changed' });
  assert.equal(status, 409);
  assert.match(body.message, /already exists/);
  assert.equal(db.business_categories.find((r) => r.value === 'general').label, 'General');
});

test('create: losing a concurrent-create race (unique violation on insert) is also a 409', async () => {
  const original = service.createCategory;
  service.createCategory = async () => { throw Object.assign(new Error('duplicate key'), { code: '23505' }); };
  try {
    assert.equal((await create(valid)).status, 409);
  } finally {
    service.createCategory = original;
  }
});

test('create: field validation (types and lengths)', async () => {
  const bad = [
    { label: undefined }, { label: '   ' }, { label: 5 }, { label: 'x'.repeat(41) },
    { emoji: 5 }, { emoji: '📱'.repeat(9) },
    { icon: 5 }, { icon: 'i'.repeat(41) },
    { displayOrder: '10' }, { displayOrder: 1.5 }, { displayOrder: -1 }, { displayOrder: 100001 },
    { isEnabled: 'true' }, { isEnabled: 1 },
    { labelTranslations: 'hi' }, { labelTranslations: [] }, { labelTranslations: null },
    { labelTranslations: { ta: 'x' } }, { labelTranslations: { hi: 5 } }, { labelTranslations: { hi: 'x'.repeat(41) } }
  ];
  for (const override of bad) {
    const { status } = await create({ ...valid, ...override });
    assert.equal(status, 400, `rejects ${JSON.stringify(override)}`);
  }
  assert.equal(db.business_categories.length, 2, 'nothing was inserted');
});

test('create: eight emoji characters are fine, counted as characters not UTF-16 units', async () => {
  assert.equal((await create({ ...valid, emoji: '📱'.repeat(8) })).status, 201);
});

test('create: empty translations are dropped so clients fall back to the label', async () => {
  const { body } = await create({ ...valid, labelTranslations: { hi: 'मोबाइल', mr: '  ' } });
  assert.deepEqual(body.data.labelTranslations, { hi: 'मोबाइल' });
});

test('update: changes only the fields sent and keeps the rest', async () => {
  const { status, body } = await update('general', { emoji: '🧰', labelTranslations: { mr: 'सामान्य' } });
  assert.equal(status, 200);
  const row = db.business_categories.find((r) => r.value === 'general');
  assert.deepEqual(
    [row.label, row.icon, row.display_order, row.is_enabled, row.emoji, row.label_translations],
    ['General', 'briefcase', 80, true, '🧰', { mr: 'सामान्य' }]
  );
  assert.equal(body.data.emoji, '🧰');
  assert.ok(row.updated_at, 'updated_at is stamped');
});

test('update: can disable a category and edit label/icon/order', async () => {
  const { status } = await update('general', { isEnabled: false, label: 'Everything', icon: 'box', displayOrder: 5 });
  assert.equal(status, 200);
  const row = db.business_categories.find((r) => r.value === 'general');
  assert.deepEqual([row.is_enabled, row.label, row.icon, row.display_order], [false, 'Everything', 'box', 5]);
});

test('update: echoing a stored emoji in icon (older rows like hotel) is accepted', async () => {
  assert.equal((await update('hotel', { label: 'Hotel', icon: '🏨', isEnabled: true })).status, 200);
});

test('update: value is immutable', async () => {
  const { status, body } = await update('general', { value: 'renamed', label: 'X' });
  assert.equal(status, 400);
  assert.match(body.message, /cannot be changed/);
  assert.deepEqual(db.business_categories.map((r) => r.value), ['general', 'hotel']);
  assert.equal(db.business_categories[0].label, 'General', 'nothing else applied either');
  assert.equal((await update('general', { value: 'general', label: 'Same value is fine' })).status, 200);
});

test('update: 404 for a missing category, 400 for an invalid or empty body', async () => {
  assert.equal((await update('nope', { label: 'X' })).status, 404);
  assert.equal((await update('general', {})).status, 400);
  assert.equal((await update('general', { label: '' })).status, 400);
  assert.equal((await update('general', { isEnabled: 'yes' })).status, 400);
  assert.equal((await update('general', { labelTranslations: { hi: 1 } })).status, 400);
});

test('admin list and public signup list both carry emoji + labelTranslations camelCased', async () => {
  await create({ ...valid, emoji: '📱', isEnabled: true, labelTranslations: { hi: 'मोबाइल' } });
  const all = await call(controller.getCategories);
  const mobile = all.body.data.categories.find((c) => c.value === 'mobile_electronics');
  assert.deepEqual([mobile.emoji, mobile.labelTranslations, mobile.isEnabled], ['📱', { hi: 'मोबाइल' }, true]);

  const pub = await call(publicController.getEnabledCategories);
  const listed = pub.body.data.categories.find((c) => c.value === 'mobile_electronics');
  assert.deepEqual([listed.emoji, listed.labelTranslations], ['📱', { hi: 'मोबाइल' }]);
  assert.ok(!('label_translations' in listed), 'no snake_case leaks');
});

test('a created-but-disabled category is known (usable for templates) but not enabled for signup', async () => {
  await create(valid);
  assert.equal(await service.isKnownCategory('mobile_electronics'), true);
  assert.equal(await service.isEnabledCategory('mobile_electronics'), false);
  await update('mobile_electronics', { isEnabled: true });
  assert.equal(await service.isEnabledCategory('mobile_electronics'), true);
});
