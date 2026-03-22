const { S3Client, PutBucketCorsCommand } = require('@aws-sdk/client-s3');
require('dotenv').config();

const client = new S3Client({ 
    region: process.env.AWS_REGION || 'eu-north-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const run = async () => {
  try {
    const data = await client.send(new PutBucketCorsCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedHeaders: ["*"],
            AllowedMethods: ["GET", "HEAD"],
            AllowedOrigins: ["*"],
            ExposeHeaders: []
          }
        ]
      }
    }));
    console.log("Success setting CORS:", data);
  } catch (err) {
    console.log("Error", err);
  }
};
run();
