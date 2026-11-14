// Rehearsal only: creates the S3 bucket the API expects (a real host's storage service has it already).
// Runs inside the API image, which has the S3 client library. Waits for the storage to come up.
import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION ?? 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY },
});
const Bucket = process.env.S3_BUCKET;

for (let attempt = 1; attempt <= 30; attempt++) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket }));
    console.warn(`Bucket ${Bucket} exists.`);
    process.exit(0);
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    if (status === 404) {
      await s3.send(new CreateBucketCommand({ Bucket }));
      console.warn(`Bucket ${Bucket} created.`);
      process.exit(0);
    }
    console.warn(`Storage not ready (attempt ${attempt}): ${error?.name ?? error}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
console.error('Storage did not come up.');
process.exit(1);
