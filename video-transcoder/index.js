require('dotenv').config();
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
ffmpeg.setFfmpegPath(FFMPEG_PATH);

// 1. Make sure the output folder exists
const outputDir = './output';
if (!fs.existsSync(outputDir)){
    fs.mkdirSync(outputDir);
}

console.log('🎬 Starting transcoding...');

// 2. The Transcoding Logic
ffmpeg('input.mp4')
  .outputOptions([
    '-hls_time 10',      // Chop video into 10-second segments
    '-hls_list_size 0',  // Include ALL segments in the playlist (don't delete old ones)
    '-f hls'             // Output format is HLS
  ])
  .output(`${outputDir}/index.m3u8`) // The master playlist file
  .on('end', () => {
    console.log('✅ Success! Transcoding finished.');
  })
  .on('error', (err) => {
    console.error('❌ Error:', err);
  })
  .run();