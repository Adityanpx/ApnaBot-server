// Run: node --test src/utils/csv.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { csvCell, toCsv } = require('./csv');

test('csvCell: plain text, null and undefined', () => {
  assert.equal(csvCell('hello'), 'hello');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
});

test('csvCell: quotes cells with comma, quote or newline and doubles inner quotes', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
});

test('csvCell: text starting with = + - @ gets a leading apostrophe', () => {
  assert.equal(csvCell('=SUM(A1:A9)'), "'=SUM(A1:A9)");
  assert.equal(csvCell('-2+3'), "'-2+3");
  assert.equal(csvCell('@cmd'), "'@cmd");
});

test('csvCell: a phone or plain number is left exactly as it is', () => {
  for (const phone of ['+919284128827', '92841 28827', '+91 (928) 412-8827', '919284128827', '0922-4128827']) {
    assert.equal(csvCell(phone), phone, phone);
  }
});

test('csvCell: injection that starts like a phone is still prefixed', () => {
  assert.equal(csvCell('+1+1'), "'+1+1");
  assert.equal(csvCell('+SUM(A1)'), "'+SUM(A1)");
  assert.equal(csvCell('+91abc'), "'+91abc");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('-2+3'), "'-2+3");
  assert.equal(csvCell('-91 98'), "'-91 98");
  assert.equal(csvCell('+'), "'+");
});

test('csvCell: a leading tab or CR is neutralised and the cell is quoted', () => {
  assert.equal(csvCell('\t=1+1'), '"\'\t=1+1"');
  assert.equal(csvCell('\r=1+1'), '"\'\r=1+1"');
});

test('csvCell: the apostrophe and CSV quoting combine', () => {
  assert.equal(csvCell('=HYPERLINK("http://x","y")'), '"\'=HYPERLINK(""http://x"",""y"")"');
});

test('csvCell: a formula character that is not first is left alone', () => {
  assert.equal(csvCell('a=b'), 'a=b');
  assert.equal(csvCell('x-ray'), 'x-ray');
});

test('csvCell: numbers and booleans are not text, so a negative number is unchanged', () => {
  assert.equal(csvCell(-5), '-5');
  assert.equal(csvCell(42), '42');
  assert.equal(csvCell(true), 'true');
});

test('csvCell: objects are written as JSON', () => {
  assert.equal(csvCell({ a: 1 }), '"{""a"":1}"');
});

test('toCsv: header from column headers, one line per row, trailing newline', () => {
  const columns = [{ key: 'name', header: 'Name' }, { key: 'note', header: 'Note' }];
  const csv = toCsv(columns, [{ name: 'Ravi', note: '=1+1' }, { name: 'Asha, K', note: null }]);
  assert.equal(csv, "Name,Note\nRavi,'=1+1\n\"Asha, K\",\n");
});

test('toCsv: no rows is just the header', () => {
  assert.equal(toCsv([{ key: 'a', header: 'A' }], []), 'A\n');
});
