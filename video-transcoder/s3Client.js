const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
require('dotenv').config();

const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'eu-north-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const BUCKET_NAME = process.env.AWS_BUCKET_NAME || 'video-transcoder-2026-amal';

// 1. Robust Upload Function (With Retries)
async function uploadToS3(filePath, fileName, folder = 'uploads') {
    const MAX_RETRIES = 3;
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            // Must create a NEW stream for every attempt
            const ext = filePath.split('.').pop().toLowerCase();
            let contentType = 'application/octet-stream'; // default
            if (ext === 'm3u8') contentType = 'application/x-mpegURL';
            else if (ext === 'ts') contentType = 'video/MP2T';
            else if (ext === 'mp4') contentType = 'video/mp4';
            else if (ext === 'jpg' || ext === 'jpeg') contentType = 'image/jpeg';
            else if (ext === 'png') contentType = 'image/png';

            const fileStream = fs.createReadStream(filePath);
            
            const command = new PutObjectCommand({
                Bucket: BUCKET_NAME,
                Key: `${folder}/${fileName}`,
                Body: fileStream,
                ContentType: contentType
            });
            
            await s3Client.send(command);
            console.log(`☁️  Uploaded to S3: ${folder}/${fileName}`);
            return; // Success - exit the function

        } catch (error) {
            console.warn(`⚠️  Upload failed (Attempt ${attempt}/${MAX_RETRIES}): ${fileName}`);
            
            if (attempt === MAX_RETRIES) {
                // If we failed 3 times, throw the error to stop the worker
                throw error;
            }
            
            // Wait 2 seconds before trying again
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
}

// 2. Download Helper (Same as before)
async function downloadFromS3(fileName, localPath) {
    console.log(`⬇️  Downloading ${fileName} from S3...`);
    const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: `uploads/${fileName}`
    });
    
    const response = await s3Client.send(command);
    return new Promise((resolve, reject) => {
        const fileStream = fs.createWriteStream(localPath);
        response.Body.pipe(fileStream)
            .on('error', reject)
            .on('finish', () => resolve());
    });
}

// 3. NEW: Get List of Videos
async function listVideos() {
    const command = new ListObjectsV2Command({
        Bucket: BUCKET_NAME,
        Prefix: 'hls/' // Only look inside the hls folder
    });

    const response = await s3Client.send(command);
    
    // AWS returns EVERYTHING (files and folders). We just want the unique folder names.
    // Example: hls/video1/master.m3u8, hls/video1/360p/index.m3u8
    
    const videos = new Set();
    
    if (response.Contents) {
        response.Contents.forEach(item => {
            // Key looks like: hls/filename/master.m3u8
            const parts = item.Key.split('/');
            if (parts.length > 1) {
                const videoName = parts[1]; // "filename"
                videos.add(videoName);
            }
        });
    }
    
    return Array.from(videos);
}


async function deleteVideoFromS3(fileName) {
    try {
        // 1. Delete original upload
        const deleteOriginalCommand = new DeleteObjectsCommand({
            Bucket: BUCKET_NAME,
            Delete: { Objects: [{ Key: `uploads/${fileName}` }] }
        });
        await s3Client.send(deleteOriginalCommand).catch(e => console.warn("Could not delete original upload", e));

        // 2. Delete all HLS files
        let isTruncated = true;
        let continuationToken = undefined;

        while (isTruncated) {
            const listCommand = new ListObjectsV2Command({
                Bucket: BUCKET_NAME,
                Prefix: `hls/${fileName}/`,
                ContinuationToken: continuationToken
            });
            const listResponse = await s3Client.send(listCommand);

            if (listResponse.Contents && listResponse.Contents.length > 0) {
                const objectsToDelete = listResponse.Contents.map(obj => ({ Key: obj.Key }));
                const deleteHlsCommand = new DeleteObjectsCommand({
                    Bucket: BUCKET_NAME,
                    Delete: { Objects: objectsToDelete }
                });
                await s3Client.send(deleteHlsCommand);
            }
            isTruncated = listResponse.IsTruncated;
            continuationToken = listResponse.NextContinuationToken;
        }
        console.log(`🗑️ Deleted S3 artifacts for ${fileName}`);
    } catch (error) {
        console.error(`Error deleting ${fileName} from S3:`, error);
        throw error;
    }
}

module.exports = { uploadToS3, downloadFromS3, listVideos, deleteVideoFromS3 };