require('dotenv').config();
const { Worker } = require('bullmq');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { downloadFromS3, uploadToS3 } = require('./s3Client');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const redisUrl = process.env.REDIS_URL || '127.0.0.1';
/*const redisOptions = redisUrl.startsWith('redis://') 
    ? { connection: { url: redisUrl } } 
    : { connection: { host: '127.0.0.1', port: 6379 } };
*/
let connectionConfig;

if (process.env.REDIS_URL) {
  const url = new URL(process.env.REDIS_URL);
  connectionConfig = {
    host: url.hostname,
    port: Number(url.port),
    password: url.password,
    username: url.username
  };
  // Auto-detect TLS requirement based on the protocol
  if (url.protocol === 'rediss:') {
      connectionConfig.tls = { rejectUnauthorized: false };
  }
  console.log(`Worker connecting to Redis at ${url.host}...`);
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
    const { filename, videoId } = job.data;
    console.log(`♻️  Processing Job: ${filename} (ID: ${videoId})`);

    const localInputPath = `temp/${filename}`;
    const localOutputDir = `output/${filename}`;

    // 1. Create clean directories
    if (!fs.existsSync('temp')) fs.mkdirSync('temp');
    if (!fs.existsSync('output')) fs.mkdirSync('output');
    if (fs.existsSync(localOutputDir)) fs.rmSync(localOutputDir, { recursive: true, force: true });
    fs.mkdirSync(localOutputDir, { recursive: true });

    try {
        console.log('⬇️  Downloading source from S3...');
        await downloadFromS3(filename, localInputPath);

        // 3. Define qualities and Thumbnail strategy
        const resolutions = [
            { name: '360p', size: '640x360', bitrate: '800k' },
            { name: '720p', size: '1280x720', bitrate: '2500k' },
            { name: '1080p', size: '1920x1080', bitrate: '5000k' }
        ];

        // Prepare the promises array for parallel execution
        const transcodingPromises = [];
        const variantPlaylists = [];
        let completedResolutions = 0;
        const totalTasks = resolutions.length + 1; // 3 resolutions + 1 thumbnail task

        // A. Add Video Transcoding Promises
        for (const res of resolutions) {
            const variantOutputDir = path.join(localOutputDir, res.name);
            fs.mkdirSync(variantOutputDir);

            const p = new Promise((resolve, reject) => {
                ffmpeg(localInputPath)
                    .output(`${variantOutputDir}/index.m3u8`)
                    .outputOptions([
                        `-vf scale=${res.size}`,
                        `-b:v ${res.bitrate}`,
                        '-hls_time 10',
                        '-hls_list_size 0',
                        '-f hls'
                    ])
                    .on('progress', (progress) => {
                        if (progress.percent) {
                            const globalProgress = ((completedResolutions * 100) + progress.percent) / totalTasks;
                            job.updateProgress(Math.round(globalProgress));
                        }
                    })
                    .on('end', () => {
                        completedResolutions++;
                        resolve();
                    })
                    .on('error', reject)
                    .run();
            });

            transcodingPromises.push(p);

            variantPlaylists.push({
                name: res.name,
                path: `${res.name}/index.m3u8`,
                bitrate: parseInt(res.bitrate) * 1000,
                resolution: res.size,
                codecs: 'avc1.42c01e,mp4a.40.2'
            });
        }

        // B. Add Thumbnail Extraction Promise
        const thumbnailPromise = new Promise((resolve, reject) => {
            ffmpeg(localInputPath)
                .screenshots({
                    timestamps: [1], // Extract frame at 1 second
                    filename: 'thumbnail.jpg',
                    folder: localOutputDir,
                    size: '1280x720'
                })
                .on('end', () => {
                    completedResolutions++;
                    resolve();
                })
                .on('error', reject);
        });

        transcodingPromises.push(thumbnailPromise);

        // 4. Run all FFmpeg tasks concurrently!
        console.log('⚙️  Extracting thumbnails and transcoding all resolutions in parallel...');
        await Promise.all(transcodingPromises);

        // 5. Create Master Playlist
        console.log('📝 Creating Master Playlist...');
        let masterContent = '#EXTM3U\n#EXT-X-VERSION:3\n';

        variantPlaylists.sort((a, b) => a.bitrate - b.bitrate);

        variantPlaylists.forEach(variant => {
            masterContent += `#EXT-X-STREAM-INF:BANDWIDTH=${variant.bitrate},RESOLUTION=${variant.resolution},CODECS="${variant.codecs}"\n`;
            masterContent += `${variant.path}\n`;
        }); 

        fs.writeFileSync(`${localOutputDir}/master.m3u8`, masterContent);

        // 6. Upload Everything to S3
        console.log('⬆️  Uploading all qualities and thumbnail to S3...');
        
        const uploadDir = async (dir, s3Prefix) => {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const fullPath = path.join(dir, file);
                if (fs.statSync(fullPath).isDirectory()) {
                    await uploadDir(fullPath, `${s3Prefix}/${file}`);
                } else {
                    await uploadToS3(fullPath, file, s3Prefix);
                }
            }
        };

        await uploadDir(localOutputDir, `hls/${filename}`);
        
        // 7. Update Database Record as Complete
        if (videoId) {
            await prisma.video.update({
                where: { id: videoId },
                data: { 
                    status: 'ready',
                    thumbnailUrl: `hls/${filename}/thumbnail.jpg`
                }
            });
        }

        job.updateProgress(100);
        console.log(`✅ Job ${filename} Completed!`);

    } catch (err) {
        console.error("❌ Worker Failed:", err);
        if (videoId) {
            await prisma.video.update({
                where: { id: videoId },
                data: { status: 'failed' }
            });
        }
        throw err;
    } finally {
        // 8. Cleanup Local Files
        if (fs.existsSync(localInputPath)) fs.unlinkSync(localInputPath);
        if (fs.existsSync(localOutputDir)) fs.rmSync(localOutputDir, { recursive: true, force: true });
    }

}, { connection: connectionConfig });