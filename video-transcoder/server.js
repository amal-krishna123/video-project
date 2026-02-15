require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { Queue, QueueEvents } = require('bullmq');
const { uploadToS3, listVideos } = require('./s3Client'); 
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// --- 1. CRITICAL REDIS FIX ---
// We MUST parse the URL and add 'tls' for Cloud Redis to work
const redisUrl = process.env.REDIS_URL;
let connectionConfig;

if (redisUrl) {
    // CLOUD MODE (Render / Upstash)
    console.log("☁️  Configuring for Cloud Redis...");
    try {
        const url = new URL(redisUrl);
        connectionConfig = {
            host: url.hostname,
            port: Number(url.port),
            username: url.username,
            password: url.password,
            // 👇 THIS IS THE MISSING PIECE THAT CAUSES THE CRASH
            tls: { rejectUnauthorized: false } 
        };
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
    methods: ["GET", "POST"]
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
        
        // Add to Queue
        const job = await videoQueue.add('transcode', { filename: req.file.filename });
        
        // Cleanup
        fs.unlink(req.file.path, () => {});
        
        res.json({ message: 'Uploaded!', jobId: job.id });
    } catch (error) {
        console.error("Upload Error:", error);
        res.status(500).json({ error: 'Upload Failed' });
    }
});

app.get('/videos', async (req, res) => {
    try {
        const videos = await listVideos();
        // Update URL based on your bucket
        const videoList = videos.map(filename => ({
            filename,
            url: `https://${process.env.BUCKET_NAME}.s3.eu-north-1.amazonaws.com/hls/${filename}/master.m3u8`
        }));
        res.json(videoList);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'List Failed' });
    }
});

// --- 8. START BACKGROUND WORKER ---
// Ensure worker.js is in the same folder!
try {
    require('./worker'); 
} catch (e) {
    console.error("⚠️ Worker failed to start:", e);
}

// --- 9. START LISTENING ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));