import React, { useState, useEffect } from 'react';
import io from 'socket.io-client';


// Use the environment variable, or fallback to localhost for development
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:3000";
const socket = io(BACKEND_URL); // Connect to Backend

export default function Upload({ onUploadSuccess }) {
    const [file, setFile] = useState(null);
    const [progress, setProgress] = useState(0);
    const [status, setStatus] = useState("Idle");
    const [videoUrl, setVideoUrl] = useState("");

    const handleUpload = async () => {
        if (!file) return;

        setStatus("Uploading...");
        const formData = new FormData();
        formData.append("video", file);

        // 1. Upload File
        const response = await fetch(`${BACKEND_URL}/upload`, {
            method: 'POST',
            body: formData
        });

        const data = await response.json();
        const jobId = data.jobId;

        // 2. Subscribe to Progress Updates
        setStatus("Processing...");
        socket.emit('subscribe', jobId);
    };

    useEffect(() => {
        // Listen for progress from Server
        socket.on('progress', (percent) => {
            setProgress(percent);
            setStatus(`Transcoding: ${percent}%`);
        });

        socket.on('status', (msg) => {
            if (msg === 'completed') {
                setStatus("Done! ✅");
                setProgress(100);
                onUploadSuccess(); // Refresh video list in parent
                // In a real app, the server would send back the final URL.
                // For now, we construct it manually or just show success.
            }
        });

        return () => {
            socket.off('progress');
            socket.off('status');
        };
    }, []);

    // inside Upload.jsx...

return (
    <div style={{ marginBottom: "20px" }}>
        <input 
            type="file" 
            id="file-upload" 
            style={{ display: "none" }} 
            onChange={(e) => setFile(e.target.files[0])} 
        />
        <label 
            htmlFor="file-upload" 
            style={{
                background: "#333",
                color: "white",
                padding: "10px 20px",
                borderRadius: "8px",
                cursor: "pointer",
                marginRight: "10px",
                border: "1px solid #555"
            }}
        >
            {file ? file.name : "📁 Choose File"}
        </label>

        <button 
            onClick={handleUpload} 
            disabled={!file}
            style={{
                background: file ? "#bb86fc" : "#555",
                color: "#000",
                padding: "10px 20px",
                borderRadius: "8px",
                border: "none",
                fontWeight: "bold",
                cursor: file ? "pointer" : "not-allowed",
                transition: "background 0.3s"
            }}
        >
            Upload Video
        </button>

        {/* Keep your status/progress bars below this */}
        <div style={{ marginTop: "20px", textAlign: "left" }}>
             {/* ... keep your existing status and progress bar code here ... */}
        </div>
    </div>
);}