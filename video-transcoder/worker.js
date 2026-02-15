require('dotenv').config();
const { Worker } = require('bullmq');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { downloadFromS3, uploadToS3 } = require('./s3Client');
const redisUrl = process.env.REDIS_URL || '127.0.0.1';
/*const redisOptions = redisUrl.startsWith('redis://') 
    ? { connection: { url: redisUrl } } 
    : { connection: { host: '127.0.0.1', port: 6379 } };
*/
let connectionConfig;

if (process.env.REDIS_URL) {
  // --- CLOUD CONFIGURATION (Render) ---
  const url = new URL(process.env.REDIS_URL);
  connectionConfig = {
    host: url.hostname,
    port: Number(url.port),
    password: url.password,
    username: url.username,
    tls: { rejectUnauthorized: false } // Required for secure Cloud Redis
  };
  console.log("Worker connecting to Cloud Redis...");
} else {
  // --- LOCAL CONFIGURATION (Laptop) ---
  connectionConfig = {
    host: '127.0.0.1',
    port: 6379
  };
  console.log("Worker connecting to Local Redis...");
}

// Set ffmpeg path from environment or default
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
ffmpeg.setFfmpegPath(FFMPEG_PATH); 

const worker = new Worker('video-transcoding', async (job) => {
    const { filename } = job.data;
    console.log(`♻️  Processing Job: ${filename}`);

    const localInputPath = `temp/${filename}`;
    const localOutputDir = `output/${filename}`;

    // 1. Create clean directories
    if (!fs.existsSync('temp')) fs.mkdirSync('temp');
    if (!fs.existsSync('output')) fs.mkdirSync('output');
    // Clean up previous output for this file if it exists
    if (fs.existsSync(localOutputDir)) fs.rmSync(localOutputDir, { recursive: true, force: true });
    fs.mkdirSync(localOutputDir, { recursive: true });

    try {
        // 2. Download Source Video
        console.log('⬇️  Downloading source from S3...');
        await downloadFromS3(filename, localInputPath);

        // 3. Define the Qualities we want (The Netflix Strategy)
        const resolutions = [
            { name: '360p', size: '640x360', bitrate: '800k' },
            { name: '720p', size: '1280x720', bitrate: '2500k' },
            { name: '1080p', size: '1920x1080', bitrate: '5000k' }
        ];

        const variantPlaylists = [];
        let totalResolutions = resolutions.length;
        let completedResolutions = 0;

        for (const res of resolutions) {
            const variantOutputDir = path.join(localOutputDir, res.name);
            fs.mkdirSync(variantOutputDir);

            await new Promise((resolve, reject) => {
                ffmpeg(localInputPath)
                    .output(`${variantOutputDir}/index.m3u8`)
                    .outputOptions([
                        `-vf scale=${res.size}`,
                        `-b:v ${res.bitrate}`,
                        '-hls_time 10',
                        '-hls_list_size 0',
                        '-f hls'
                    ])
                    // 👇 NEW: Report Progress
                    .on('progress', (progress) => {
                        // Simple calculation: If we are on resolution 1/3 and it's 50% done...
                        // Global Progress = (CompletedRes * 100 + CurrentResProgress) / TotalRes
                        if (progress.percent) {
                            const globalProgress = ((completedResolutions * 100) + progress.percent) / totalResolutions;
                            job.updateProgress(Math.round(globalProgress)); // Tell Redis the %
                        }
                    })
                    .on('end', () => {
                        completedResolutions++;
                        resolve();
                    })
                    .on('error', reject)
                    .run();
            });

            // Store complete variant info for master playlist (avoid redundant lookups)
            variantPlaylists.push({
                name: res.name,
                path: `${res.name}/index.m3u8`,
                bitrate: parseInt(res.bitrate) * 1000, // Convert 'k' to bits/sec (e.g., '800k' -> 800000)
                resolution: res.size,
                codecs: 'avc1.42c01e,mp4a.40.2' // H.264 video + AAC audio (HLS spec)
            });
        }

        // 5. Create the Master Playlist (HLS Specification Compliant)
        // This file lists all available quality variants for adaptive streaming
        console.log('📝 Creating Master Playlist...');
        let masterContent = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n';

        // Sort by bitrate (ascending) for better player heuristics
        variantPlaylists.sort((a, b) => a.bitrate - b.bitrate);

        variantPlaylists.forEach(variant => {
            // HLS spec format: includes bandwidth, resolution, and codec info
            masterContent += `#EXT-X-STREAM-INF:BANDWIDTH=${variant.bitrate},RESOLUTION=${variant.resolution},CODECS="${variant.codecs}"\n`;
            masterContent += `${variant.path}\n`;
        }); 

        fs.writeFileSync(`${localOutputDir}/master.m3u8`, masterContent);

        // 6. Upload EVERYTHING to S3 (Folders + Files)
        console.log('⬆️  Uploading all qualities to S3...');
        
        // Helper function to upload folders recursively

        const uploadDir = async (dir, s3Prefix) => {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const fullPath = path.join(dir, file);
                if (fs.statSync(fullPath).isDirectory()) {
                    await uploadDir(fullPath, `${s3Prefix}/${file}`);
                } else {
                    // Upload file
                    await uploadToS3(fullPath, file, s3Prefix);
                }
            }
        };

        // Upload the whole 'output/filename' folder to 'hls/filename' in S3
        await uploadDir(localOutputDir, `hls/${filename}`);
        
        job.updateProgress(100);

        console.log(`✅ Job ${filename} Completed!`);
        console.log(`🔗 Master URL: https://YOUR-BUCKET.s3.eu-north-1.amazonaws.com/hls/${filename}/master.m3u8`);

    } catch (err) {
        console.error("❌ Worker Failed:", err);
        throw err; // Mark job as failed
    } finally {
        // 7. Cleanup Local Files
        if (fs.existsSync(localInputPath)) fs.unlinkSync(localInputPath);
        if (fs.existsSync(localOutputDir)) fs.rmSync(localOutputDir, { recursive: true, force: true });
    }

}, { connection: connectionConfig });