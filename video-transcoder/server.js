require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { Queue, QueueEvents } = require('bullmq');
const { uploadToS3, listVideos } = require('./s3Client'); // Combined import
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// --- 1. ROBUST REDIS CONFIGURATION ---
const redisUrl = process.env.REDIS_URL;
let connectionConfig;

if (redisUrl) {
    // Cloud Config (Render / Upstash)
    console.log("☁️  Using Cloud Redis");
    try {
        const url = new URL(redisUrl);
        connectionConfig = {
            host: url.hostname,
            port: Number(url.port),
            username: url.username,
            password: url.password,
            tls: { rejectUnauthorized: false } // CRITICAL for Upstash/Cloud
        };
    } catch (e) {
        console.error("❌ Invalid REDIS_URL:", e);
    }
} else {
    // Local Config
    console.log("💻 Using Local Redis");
    connectionConfig = { host: '127.0.0.1', port: 6379 };
}

// Wrap in the format BullMQ expects
const redisOptions = { connection: connectionConfig };

// --- 2. INITIALIZE APP ---
const app = express();

// CORS FIX: Allow '*', but DO NOT set credentials: true
app.use(cors({
    origin: '*',
    methods: ["GET", "POST", "PUT", "DELETE"]
}));

app.use(express.json());

// --- 3. CREATE HTTP SERVER & SOCKET ---
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: '*',           // Allow All
        methods: ["GET", "POST"]
        // REMOVED: credentials: true (Conflicts with '*')
    },
    transports: ['websocket', 'polling'] // Ensure compatibility
});

// --- 4. SETUP QUEUES ---
const videoQueue = new Queue('video-transcoding', redisOptions);
const queueEvents = new QueueEvents('video-transcoding', redisOptions);

const upload = multer({ dest: 'temp/' });

// --- 5. SOCKET CONNECTION LOGIC ---
io.on('connection', (socket) => {
    console.log(`⚡ User connected: ${socket.id}`);

    // Listen for "job-updates" room joining
    socket.on('subscribe', (jobId) => {
        console.log(`User ${socket.id} subscribed to job ${jobId}`);
        socket.join(jobId);
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
    });
});

// --- 6. GLOBAL QUEUE LISTENERS ---
// These run ONCE and broadcast to whoever is in the room
queueEvents.on('progress', ({ jobId, data }) => {
    io.to(jobId).emit('progress', data);
});

queueEvents.on('completed', ({ jobId }) => {
    console.log(`✅ Job ${jobId} Completed`);
    io.to(jobId).emit('status', 'completed');
});

queueEvents.on('failed', ({ jobId, failedReason }) => {
    console.error(`❌ Job ${jobId} Failed: ${failedReason}`);
    io.to(jobId).emit('status', 'failed');
});


// --- 7. API ROUTES ---
app.get('/', (req, res) => {
    res.send('<h1>✅ Video Transcoding Server is Running!</h1>');
});

app.post('/upload', upload.single('video'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        const { filename, path: localPath, mimetype } = req.file;
        console.log(`📥 Uploading ${filename} to S3...`);

        // Basic validation
        if (!mimetype.startsWith('video/')) {
            fs.unlinkSync(localPath);
            return res.status(400).json({ error: 'Not a video file' });
        }

        // Upload & Queue
        await uploadToS3(localPath, filename);
        
        // Add job to queue
        const job = await videoQueue.add('transcode', { filename });
        
        // Clean up local file
        fs.unlink(localPath, () => {});

        console.log(`User subscribed to job ${job.id}`);
        res.json({ message: 'Uploaded!', jobId: job.id });

    } catch (error) {
        console.error('❌ Upload error:', error);
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Upload failed', details: error.message });
    }
});

app.get('/videos', async (req, res) => {
    try {
        const videos = await listVideos();
        // Update this URL to match YOUR bucket URL structure
        const videoList = videos.map(filename => ({
            filename,
            // Ensure this points to the right region/bucket
            url: `https://${process.env.BUCKET_NAME}.s3.eu-north-1.amazonaws.com/hls/${filename}/master.m3u8`
        }));
        
        res.json(videoList);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to list videos' });
    }
});

// --- 8. START WORKER & SERVER ---
require('./worker'); // Start the background worker

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server + Socket running on port ${PORT}`);
});