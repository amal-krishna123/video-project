import React, { useRef, useState, useEffect } from "react";
import Upload from "./Upload";
import VideoPlayer from "./VideoPlayer"; 
import "./App.css"; // Import our new styles
// Use the environment variable, or fallback to localhost for development
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:3000";

// --- Simple Gallery Component ---
const VideoGallery = ({ videos, onSelect, onEdit, onDelete }) => {
  return (
    <div>
      <h3 style={{ color: "#fff", marginBottom: "20px" }}>Your Library</h3>
      {videos.length === 0 ? (
        <p style={{ color: "#777" }}>No videos found. Upload your first one!</p>
      ) : (
        <div className="gallery-grid">
          {videos.map((v) => (
            <div 
                key={v.id} 
                className="video-card" 
                onClick={() => v.status === 'ready' && onSelect(v.url)}
                style={{ opacity: v.status === 'ready' ? 1 : 0.6, cursor: v.status === 'ready' ? 'pointer' : 'not-allowed' }}
            >
              <div className="thumbnail-placeholder" style={{ padding: 0, overflow: 'hidden' }}>
                {v.thumbnailUrl ? (
                    <img src={v.thumbnailUrl} alt="Thumbnail" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                    <span style={{ padding: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                        {v.status === 'processing' ? '⏳ Processing...' : v.status === 'failed' ? '❌ Failed' : '🎬'}
                    </span>
                )}
              </div>
              <div className="video-info" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                    <h4 className="video-title">{v.originalName || v.filename}</h4>
                    <p className="video-meta">
                    {v.status === 'ready' ? 'HLS Stream • Multi-Bitrate' : `Status: ${v.status}`}
                    </p>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                    <button 
                        title="Edit Name"
                        onClick={(e) => { e.stopPropagation(); onEdit(v.id, v.originalName || v.filename); }} 
                        style={{ background: 'transparent', border: 'none', color: '#bb86fc', cursor: 'pointer', padding: '4px', fontSize: '18px' }}
                    >✏️</button>
                    <button 
                        title="Delete Video"
                        onClick={(e) => { e.stopPropagation(); onDelete(v.id); }} 
                        style={{ background: 'transparent', border: 'none', color: '#ff5252', cursor: 'pointer', padding: '4px', fontSize: '18px' }}
                    >🗑️</button>
                </div>
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
      const res = await fetch(`${BACKEND_URL}/videos`);
      const data = await res.json();
      setVideos(data);
    } catch (err) {
      console.error("Error fetching videos:", err);
    }
  };

  useEffect(() => {
    fetchVideos();
  }, []);

  const handleDelete = async (id) => {
    if (!window.confirm("Are you sure you want to delete this video? This action cannot be undone.")) return;
    try {
      await fetch(`${BACKEND_URL}/videos/${id}`, { method: 'DELETE' });
      fetchVideos();
      // If the deleted video is currently playing, stop it
      if (videoLink && videos.find(v => v.id === id)?.url === videoLink) {
         setVideoLink(null);
      }
    } catch (e) {
      console.error(e);
      alert("Failed to delete video");
    }
  };

  const handleEdit = async (id, currentName) => {
    const newName = window.prompt("Enter new video name:", currentName);
    if (!newName || newName === currentName) return;
    try {
      await fetch(`${BACKEND_URL}/videos/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ originalName: newName })
      });
      fetchVideos();
    } catch (e) {
      console.error(e);
      alert("Failed to update video name");
    }
  };

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
        <h1>EasyStream</h1>
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
      <VideoGallery videos={videos} onSelect={setVideoLink} onDelete={handleDelete} onEdit={handleEdit} />
    </div>
  );
}