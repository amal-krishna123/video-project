require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { Queue, QueueEvents } = require('bullmq');
const { uploadToS3, listVideos, deleteVideoFromS3 } = require('./s3Client'); 
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const { getSignedCookies } = require('@aws-sdk/cloudfront-signer');

// --- 1. CRITICAL REDIS FIX ---
// We MUST parse the URL and add 'tls' for Cloud Redis to work
const redisUrl = process.env.REDIS_URL;
let connectionConfig;

if (redisUrl) {
    console.log(`🔗 Configuring Redis with URL: ${redisUrl}`);
    try {
        const url = new URL(redisUrl);
        connectionConfig = {
            host: url.hostname,
            port: Number(url.port),
            username: url.username,
            password: url.password
        };
        // Auto-detect TLS requirement based on the protocol
        if (url.protocol === 'rediss:') {
            connectionConfig.tls = { rejectUnauthorized: false };
        }
    } catch (e) {
        console.error("❌ Failed to parse REDIS_URL:", e);
    }
} else {
    // LOCAL MODE
    console.log("💻 Configuring for Local Redis...");
    connectionConfig = { host: '127.0.0.1', port: 6379 };
}

// --- 2. SETUP APP & CORS ---
const app = express();

// Allow Everyone ('*') but NO credentials
app.use(cors({
    origin: '*', 
    methods: ["GET", "POST", "PUT", "DELETE"]
}));

app.use(express.json());

// --- 3. CREATE SERVER & SOCKET ---
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: '*',           // Allow All Origins
        methods: ["GET", "POST"],
        allowEIO3: true        // Compatibility mode
        // ❌ REMOVED: credentials: true (This was causing the conflict)
    },
    transports: ['websocket', 'polling'] 
});

// --- 4. INITIALIZE QUEUES (Safely) ---
// We pass the 'connectionConfig' we created in Step 1
const videoQueue = new Queue('video-transcoding', { connection: connectionConfig });
const queueEvents = new QueueEvents('video-transcoding', { connection: connectionConfig });

const upload = multer({ dest: 'temp/' });

// --- 5. SOCKET EVENTS ---
io.on('connection', (socket) => {
    console.log(`⚡ Socket Connected: ${socket.id}`);

    socket.on('subscribe', (jobId) => {
        console.log(`User ${socket.id} watching job ${jobId}`);
        socket.join(jobId);
    });

    socket.on('disconnect', () => {
        console.log(`❌ Socket Disconnected: ${socket.id}`);
    });
});

// --- 6. QUEUE PROGRESS EVENTS ---
queueEvents.on('progress', ({ jobId, data }) => {
    io.to(jobId).emit('progress', data);
});

queueEvents.on('completed', ({ jobId }) => {
    io.to(jobId).emit('status', 'completed');
});

queueEvents.on('failed', ({ jobId, failedReason }) => {
    console.error(`Job ${jobId} failed: ${failedReason}`);
    io.to(jobId).emit('status', 'failed');
});

// --- 7. ROUTES ---
app.get('/', (req, res) => res.send('<h1>✅ Server is Alive</h1>'));

app.post('/upload', upload.single('video'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file' });
        
        console.log(`📥 Processing ${req.file.filename}...`);
        
        // Upload to S3
        await uploadToS3(req.file.path, req.file.filename);
        
        // Create DB Record
        const newVideo = await prisma.video.create({
            data: {
                filename: req.file.filename,
                originalName: req.file.originalname,
                status: 'processing'
            }
        });

        // Add to Queue
        const job = await videoQueue.add('transcode', { filename: req.file.filename, videoId: newVideo.id });
        
        // Cleanup
        fs.unlink(req.file.path, () => {});
        
        res.json({ message: 'Uploaded!', jobId: job.id, videoId: newVideo.id });
    } catch (error) {
        console.error("Upload Error:", error);
        res.status(500).json({ error: 'Upload Failed' });
    }
});

app.get('/videos', async (req, res) => {
    try {
        const videos = await prisma.video.findMany({
            orderBy: { createdAt: 'desc' }
        });
        
        const videoList = videos.map(v => {
            // Support Signed URLs later, or direct CloudFront/S3 URLs
            const baseUrl = process.env.CLOUDFRONT_DOMAIN 
                ? `https://${process.env.CLOUDFRONT_DOMAIN}`
                : `https://${process.env.AWS_BUCKET_NAME}.s3.eu-north-1.amazonaws.com`;
                
            return {
                id: v.id,
                filename: v.filename,
                originalName: v.originalName,
                status: v.status,
                thumbnailUrl: v.thumbnailUrl ? `${baseUrl}/${v.thumbnailUrl}` : null,
                url: `${baseUrl}/hls/${v.filename}/master.m3u8`,
                createdAt: v.createdAt
            };
        });

        res.json(videoList);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'List Failed' });
    }
});

// --- 7B. VIDEO MANAGEMENT ---
app.delete('/videos/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const video = await prisma.video.findUnique({ where: { id } });
        if (!video) return res.status(404).json({ error: 'Video not found' });

        // Delete from S3
        await deleteVideoFromS3(video.filename);

        // Delete from DB
        await prisma.video.delete({ where: { id } });

        res.json({ message: 'Video deleted' });
    } catch (e) {
        console.error("Delete Error:", e);
        res.status(500).json({ error: 'Delete Failed' });
    }
});

app.put('/videos/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { originalName } = req.body;
        
        if (!originalName) return res.status(400).json({ error: 'Name is required' });

        const updated = await prisma.video.update({
            where: { id },
            data: { originalName }
        });

        res.json(updated);
    } catch (e) {
        console.error("Update Error:", e);
        res.status(500).json({ error: 'Update Failed' });
    }
});

// --- 7B. CLOUDFRONT SIGNED COOKIES ---
app.get('/auth/cookies', (req, res) => {
    try {
        if (!process.env.CLOUDFRONT_DOMAIN || (!process.env.CLOUDFRONT_KEY_PAIR_ID && !process.env.CLOUDFRONT_PRIVATE_KEY)) {
            // If Cloudfront isn't set up yet, silently ignore to not break the app
            return res.json({ message: "Cloudfront not configured locally." });
        }

        const cloudfrontDomain = process.env.CLOUDFRONT_DOMAIN;
        // Make the policy valid for 1 hour
        const url = `https://${cloudfrontDomain}/*`;
        const policy = JSON.stringify({
            Statement: [
                {
                    Resource: url,
                    Condition: {
                        DateLessThan: {
                            'AWS:EpochTime': Math.floor((Date.now() + 1000 * 60 * 60) / 1000)
                        }
                    }
                }
            ]
        });

        // Ensure key is formatted correctly (convert literal \n to actual newlines if in .env)
        const privateKey = process.env.CLOUDFRONT_PRIVATE_KEY.replace(/\\n/g, '\n');

        const cookies = getSignedCookies({
            keyPairId: process.env.CLOUDFRONT_KEY_PAIR_ID,
            privateKey: privateKey,
            policy: policy
        });

        // Set the cookies on the client's browser
        for (const [key, value] of Object.entries(cookies)) {
            res.cookie(key, value, {
                domain: cloudfrontDomain,
                path: '/',
                httpOnly: true,
                secure: true,
                sameSite: 'none' // Important for cross-origin requests
            });
        }

        res.json({ message: "Cookies set successfully" });
    } catch (e) {
        console.error("Cookie signing error:", e);
        res.status(500).json({ error: "Failed to sign cookies" });
    }
});

// --- 8. START BACKGROUND WORKER ---
// Ensure worker.js is in the same folder!
// try {
//     require('./worker'); 
// } catch (e) {
//     console.error("⚠️ Worker failed to start:", e);
// }

// --- 9. START LISTENING & GRACEFUL SHUTDOWN ---
const PORT = process.env.PORT || 3000;
const activeServer = server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

const gracefulShutdown = async () => {
    console.log('🔄 Shutting down gracefully...');
    activeServer.close(() => {
        console.log('🛑 HTTP server closed.');
    });

    try {
        // Clean up temp directory
        if (fs.existsSync('temp')) {
            const files = fs.readdirSync('temp');
            files.forEach(f => fs.unlinkSync(`temp/${f}`));
            console.log('🧹 Cleaned up temporary files.');
        }
        await prisma.$disconnect();
        console.log('🔌 Database disconnected.');
    } catch (e) {
        console.error("Error during cleanup:", e);
    }
    process.exit(0);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);