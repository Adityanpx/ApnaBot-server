// Run: node --test src/services/r2.service.deleteObjects.test.js
// r2.service.deleteObjects: at most 1000 keys per request, per-key errors reported,
// a whole failed request marks its keys failed. listObjects follows continuation tokens.
const test = require('node:test');
const assert = require('node:assert/strict');

const sent = [];
let respond;
const stub = (id, exports) => { const p = require.resolve(id); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/env', { R2_ENDPOINT: 'https://r2.test', R2_ACCESS_KEY_ID: 'a', R2_SECRET_ACCESS_KEY: 'b', R2_BUCKET_NAME: 'bucket', R2_PUBLIC_URL: 'https://p.test' });
class Cmd { constructor(input) { this.input = input; } }
stub('@aws-sdk/client-s3', {
  S3Client: class { send(cmd) { sent.push(cmd); return respond(cmd); } },
  PutObjectCommand: class extends Cmd {}, DeleteObjectCommand: class extends Cmd {},
  DeleteObjectsCommand: class DeleteObjectsCommand extends Cmd {}, ListObjectsV2Command: class ListObjectsV2Command extends Cmd {}
});
const r2 = require('./r2.service');

test.beforeEach(() => { sent.length = 0; respond = async () => ({}); });

test('deleteObjects batches in groups of 1000', async () => {
  const keys = Array.from({ length: 2500 }, (_, i) => `k/${i}`);
  const { failed } = await r2.deleteObjects(keys);
  assert.deepEqual(failed, []);
  assert.deepEqual(sent.map(c => c.input.Delete.Objects.length), [1000, 1000, 500]);
  assert.ok(sent.every(c => c.input.Bucket === 'bucket' && c.input.Delete.Quiet === true));
});

test('deleteObjects reports per-key errors and failed requests', async () => {
  respond = async (cmd) => (cmd.input.Delete.Objects[0].Key === 'a/0'
    ? { Errors: [{ Key: 'a/1', Message: 'AccessDenied' }] }
    : Promise.reject(new Error('network')));
  const keys = [...Array.from({ length: 1000 }, (_, i) => `a/${i}`), 'b/0', 'b/1'];
  const { failed } = await r2.deleteObjects(keys);
  assert.deepEqual(failed, [{ key: 'a/1', message: 'AccessDenied' }, { key: 'b/0', message: 'network' }, { key: 'b/1', message: 'network' }]);
});

test('listObjects follows continuation tokens and stops at maxObjects', async () => {
  let page = 0;
  respond = async () => {
    page += 1;
    return { Contents: [{ Key: `p${page}/a`, Size: 5, LastModified: new Date(0) }, { Key: `p${page}/b`, Size: 7 }], IsTruncated: page < 3, NextContinuationToken: `t${page}` };
  };
  let res = await r2.listObjects('p');
  assert.deepEqual([res.objects.length, res.truncated], [6, false]);
  assert.equal(sent[1].input.ContinuationToken, 't1');
  page = 0;
  res = await r2.listObjects('p', { maxObjects: 3 });
  assert.deepEqual([res.objects.length, res.truncated], [4, true]);
});
