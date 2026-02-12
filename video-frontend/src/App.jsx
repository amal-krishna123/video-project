import React, { useRef, useState, useEffect } from "react";
import Upload from "./Upload";
import VideoPlayer from "./VideoPlayer"; 
import "./App.css"; // Import our new styles

// --- Simple Gallery Component ---
const VideoGallery = ({ videos, onSelect }) => {
  return (
    <div>
      <h3 style={{ color: "#fff", marginBottom: "20px" }}>Your Library</h3>
      {videos.length === 0 ? (
        <p style={{ color: "#777" }}>No videos found. Upload your first one!</p>
      ) : (
        <div className="gallery-grid">
          {videos.map((v) => (
            <div key={v.filename} className="video-card" onClick={() => onSelect(v.url)}>
              <div className="thumbnail-placeholder">🎬</div>
              <div className="video-info">
                <h4 className="video-title">{v.filename}</h4>
                <p className="video-meta">HLS Stream • 1080p</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// --- Main App ---
export default function App() {
  const playerRef = useRef(null);
  const [videoLink, setVideoLink] = useState(null);
  const [videos, setVideos] = useState([]);

  const fetchVideos = async () => {
    try {
      const res = await fetch("http://localhost:3000/videos");
      const data = await res.json();
      setVideos(data);
    } catch (err) {
      console.error("Error fetching videos:", err);
    }
  };

  useEffect(() => {
    fetchVideos();
  }, []);

  const videoJsOptions = {
    autoplay: true,
    controls: true,
    responsive: true,
    fluid: true,
    sources: videoLink ? [{ src: videoLink, type: "application/x-mpegURL" }] : []
  };

  const handlePlayerReady = (player) => {
    playerRef.current = player;
  };

  return (
    <div className="container">
      <div className="header">
        <h1>StreamCloud</h1>
        <p>Adaptive Bitrate Video Streaming</p>
      </div>

      <div className="main-card">
        {/* Upload Section */}
        <div className="upload-section">
          <Upload onUploadSuccess={fetchVideos} />
        </div>

        {/* Player Section */}
        {videoLink ? (
           <div className="video-wrapper" key={videoLink}>
             <VideoPlayer options={videoJsOptions} onReady={handlePlayerReady} />
           </div>
        ) : (
          <div style={{ 
            padding: "60px", 
            textAlign: "center", 
            background: "#121212", 
            borderRadius: "12px",
            border: "2px dashed #333" 
          }}>
            <p style={{ color: "#777" }}>Select a video from your library to start watching</p>
          </div>
        )}
      </div>

      {/* Gallery Section */}
      <VideoGallery videos={videos} onSelect={setVideoLink} />
    </div>
  );
}