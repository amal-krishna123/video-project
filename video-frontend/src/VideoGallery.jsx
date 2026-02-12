import React from 'react';

export default function VideoGallery({ videos, onSelectVideo }) {
    return (
        <div style={{ marginTop: "40px" }}>
            <h3>📚 Your Library</h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "10px" }}>
                {videos.map((video) => (
                    <div 
                        key={video.filename} 
                        onClick={() => onSelectVideo(video.url)}
                        style={{ 
                            border: "1px solid #ccc", 
                            padding: "10px", 
                            cursor: "pointer",
                            borderRadius: "8px",
                            textAlign: "center",
                            background: "#f9f9f9"
                        }}
                    >
                        <span style={{ fontSize: "30px" }}>🎬</span>
                        <p style={{ fontWeight: "bold", wordBreak: "break-all" }}>
                            {video.filename.substring(0, 10)}...
                        </p>
                        <small>Click to Play</small>
                    </div>
                ))}
            </div>
        </div>
    );
}