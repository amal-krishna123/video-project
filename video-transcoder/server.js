require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { Queue,QueueEvents } = require('bullmq');
const { uploadToS3 } = require('./s3Client');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { listVideos } = require('./s3Client');
const redisUrl = process.env.REDIS_URL;
require('./worker');

if (!redisUrl && process.env.NODE_ENV === 'production') {
    console.warn('⚠️ WARNING: REDIS_URL not set in production environment!');
    console.warn('Please set REDIS_URL environment variable on Render dashboard');
}

const redisOptions = redisUrl
    ? { connection: { url: redisUrl } }  // Cloud (Upstash or similar)
    : { connection: { host: '127.0.0.1', port: 6379 } }; // Local fallback (development only)

const app = express();
const allowedOrigins = [
    'http://localhost:5173',
    'http://localhost:3000',
    process.env.FRONTEND_URL || 'https://video-project-f96jdie06-amals-projects-df88c284.vercel.app'
];

app.use(cors({
    origin: function(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('CORS not allowed'));
        }
    },
    methods: ["GET", "POST"],
    credentials: true
}));

// 1. Create HTTP Server & Socket.io
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
        credentials: true,
        allowEIO3: true
    }
});

// 2. Setup Queue
const videoQueue = new Queue('video-transcoding', redisOptions);
const queueEvents = new QueueEvents('video-transcoding', redisOptions);

const upload = multer({ dest: 'temp/' });

// 3. Socket Connection Logic
io.on('connection', (socket) => {
    console.log('⚡ User connected:', socket.id);
    
    // Listen for "job-updates" room joining
    socket.on('subscribe', (jobId) => {
        console.log(`User ${socket.id} subscribed to job ${jobId}`);
        socket.join(jobId); // Join a specific room for this job
    });
});

// 4. Listen for Queue Events (Global)
// When a job progresses, tell the specific roomREDIS_HOST, port: REDIS_PORT

queueEvents.on('progress', ({ jobId, data }) => {
    // "data" is the percentage (e.g., 50)
    io.to(jobId).emit('progress', data);
});

queueEvents.on('completed', ({ jobId }) => {
    io.to(jobId).emit('status', 'completed');
});

queueEvents.on('failed', ({ jobId }) => {
    io.to(jobId).emit('status', 'failed');
});


app.post('/upload', upload.single('video'), async (req, res) => {
    try {
        // Validate file exists
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        // Validate file is a video
        const validVideoTypes = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska'];
        if (!validVideoTypes.includes(req.file.mimetype)) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: 'Invalid file type. Please upload a video file.' });
        }

        const { filename, path: localPath } = req.file;
        console.log(`📥 Uploading ${filename} to S3...`);

        // Upload & Queue
        await uploadToS3(localPath, filename);
        
        // Add job to queue
        const job = await videoQueue.add('transcode', { filename });

        fs.unlink(localPath, () => {});

        // Return the Job ID so frontend can listen to it
        res.json({ message: 'Uploaded!', jobId: job.id });
    } catch (error) {
        console.error('❌ Upload error:', error);
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ error: 'Upload failed', details: error.message });
    }
});

app.get('/videos', async (req, res) => {
    try {
        const videos = await listVideos();
        // Return list of URLs
        const videoList = videos.map(filename => ({
            filename,
            url: `https://video-transcoder-2026-amal.s3.eu-north-1.amazonaws.com/hls/${filename}/master.m3u8`
        }));
        
        res.json(videoList);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to list videos' });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server + Socket running on ${PORT}`));