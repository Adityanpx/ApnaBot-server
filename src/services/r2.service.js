const { S3Client, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const config = require('../config/env');

const r2 = new S3Client({
  region: 'auto',
  endpoint: config.R2_ENDPOINT,
  credentials: {
    accessKeyId: config.R2_ACCESS_KEY_ID,
    secretAccessKey: config.R2_SECRET_ACCESS_KEY,
  },
});

/**
 * Upload a file buffer to R2
 * @param {Buffer} fileBuffer - file buffer (e.g. from multer memoryStorage)
 * @param {string} folder - e.g. 'business-profiles'
 * @param {string} publicId - filename without extension
 * @param {string} mimetype - e.g. 'image/png'
 * @returns {Promise<{ url: string, key: string }>}
 */
const uploadImage = async (fileBuffer, folder, publicId, mimetype) => {
  const ext = mimetype.split('/')[1];
  const key = `${folder}/${publicId}.${ext}`;

  await r2.send(new PutObjectCommand({
    Bucket: config.R2_BUCKET_NAME,
    Key: key,
    Body: fileBuffer,
    ContentType: mimetype,
  }));

  return {
    url: `${config.R2_PUBLIC_URL}/${key}`,
    key,
  };
};

/**
 * Delete a file from R2 by its key
 * @param {string} key
 */
const deleteImage = async (key) => {
  return r2.send(new DeleteObjectCommand({
    Bucket: config.R2_BUCKET_NAME,
    Key: key,
  }));
};

const DELETE_BATCH_MAX = 1000; // S3 DeleteObjects limit

/**
 * List the objects under a prefix (storage cleanup). Stops after maxObjects.
 * @returns {Promise<{ objects: {key:string,size:number,lastModified:Date|null}[], truncated: boolean }>}
 */
const listObjects = async (prefix, { maxObjects = 200000 } = {}) => {
  const objects = [];
  let token;
  do {
    const res = await r2.send(new ListObjectsV2Command({
      Bucket: config.R2_BUCKET_NAME,
      Prefix: prefix,
      ContinuationToken: token
    }));
    for (const o of res.Contents || []) {
      objects.push({ key: o.Key, size: o.Size || 0, lastModified: o.LastModified || null });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token && objects.length < maxObjects);
  return { objects, truncated: !!token };
};

/**
 * Delete many objects, at most 1000 per request. A key that is already gone
 * counts as deleted (S3 semantics).
 * @returns {Promise<{ failed: {key:string,message:string}[] }>}
 */
const deleteObjects = async (keys) => {
  const failed = [];
  for (let i = 0; i < keys.length; i += DELETE_BATCH_MAX) {
    const chunk = keys.slice(i, i + DELETE_BATCH_MAX);
    try {
      const res = await r2.send(new DeleteObjectsCommand({
        Bucket: config.R2_BUCKET_NAME,
        Delete: { Objects: chunk.map(Key => ({ Key })), Quiet: true }
      }));
      for (const e of res.Errors || []) failed.push({ key: e.Key, message: e.Message || e.Code || 'delete failed' });
    } catch (err) {
      chunk.forEach(key => failed.push({ key, message: err.message }));
    }
  }
  return { failed };
};

module.exports = { uploadImage, deleteImage, listObjects, deleteObjects, DELETE_BATCH_MAX };
