// /Quizway_v2-main/api/services/storageService.js
import fs from "fs";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const S3_BUCKET = process.env.S3_BUCKET || null;
const S3_REGION = process.env.S3_REGION || process.env.AWS_REGION || "us-east-1";

let s3client = null;
if (S3_BUCKET) {
  s3client = new S3Client({ region: S3_REGION });
}

export async function uploadToS3IfConfigured(source, destFilename, requestId, opts = {}) {
  if (!s3client) return null;
  try {
    let body;
    if (opts.isBuffer) {
      body = source;
    } else {
      body = fs.readFileSync(source);
    }
    const key = `${destFilename}`;
    await s3client.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: body,
    }));
    // Build URL (public bucket assumed). If private, return key only.
    const url = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${encodeURIComponent(key)}`;
    return url;
  } catch (err) {
    console.error(`[${requestId}] S3 upload error:`, err?.message || err);
    throw err;
  }
}
