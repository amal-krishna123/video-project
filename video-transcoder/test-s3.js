const { uploadToS3 } = require('./s3Client');

// Upload your input.mp4 and name it 'test.mp4' in the cloud
uploadToS3('./input.mp4', 'test.mp4');