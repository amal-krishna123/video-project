import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';

// Use the environment variable, or fallback to localhost for development
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:3000";
const socket = io(BACKEND_URL); // Connect to Backend

// Utility function to format bytes
const formatBytes = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
};

// Utility function to format time
const formatTime = (seconds) => {
    if (seconds < 0) return '--:--';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
};

export default function Upload({ onUploadSuccess }) {
    const [file, setFile] = useState(null);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [transcodeProgress, setTranscodeProgress] = useState(0);
    const [status, setStatus] = useState("Idle");
    const [isLoading, setIsLoading] = useState(false);
    const [uploadStartTime, setUploadStartTime] = useState(null);
    const [uploadSpeed, setUploadSpeed] = useState(0);
    const [timeRemaining, setTimeRemaining] = useState(0);
    const [showSuccess, setShowSuccess] = useState(false);
    const [error, setError] = useState(null);
    const uploadedBytesRef = useRef(0);

    const handleUpload = async () => {
        if (!file) return;

        try {
            setError(null);
            setIsLoading(true);
            setStatus("Uploading...");
            setUploadProgress(0);
            setTranscodeProgress(0);
            setUploadStartTime(Date.now());
            uploadedBytesRef.current = 0;

            const formData = new FormData();
            formData.append("video", file);

            // 1. Upload File with progress tracking
            const xhr = new XMLHttpRequest();

            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable) {
                    const percentComplete = (e.loaded / e.total) * 100;
                    setUploadProgress(percentComplete);
                    uploadedBytesRef.current = e.loaded;

                    // Calculate upload speed (bytes per second)
                    const elapsedSeconds = (Date.now() - uploadStartTime) / 1000;
                    const speed = e.loaded / elapsedSeconds;
                    setUploadSpeed(speed);

                    // Calculate time remaining for upload
                    const remainingBytes = e.total - e.loaded;
                    const remainingSeconds = remainingBytes / speed;
                    setTimeRemaining(remainingSeconds);
                }
            });

            return new Promise((resolve, reject) => {
                xhr.onload = async () => {
                    if (xhr.status === 200) {
                        const data = JSON.parse(xhr.responseText);
                        const jobId = data.jobId;

                        // 2. Subscribe to Progress Updates
                        setStatus("Processing...");
                        setUploadProgress(100);
                        setTranscodeProgress(0);
                        setTimeRemaining(0);
                        socket.emit('subscribe', jobId);
                        resolve();
                    } else {
                        reject(new Error('Upload failed'));
                    }
                };

                xhr.onerror = () => {
                    reject(new Error('Network error'));
                };

                xhr.open('POST', `${BACKEND_URL}/upload`);
                xhr.send(formData);
            });
        } catch (err) {
            setError(err.message || 'Upload failed. Please try again.');
            setIsLoading(false);
            setStatus("Error");
        }
    };

    useEffect(() => {
        // Listen for progress from Server
        socket.on('progress', (percent) => {
            setTranscodeProgress(percent);
            setStatus(`Processing: ${percent}%`);
        });

        socket.on('status', (msg) => {
            if (msg === 'completed') {
                setStatus("Upload Complete! ✅");
                setTranscodeProgress(100);
                setIsLoading(false);
                setShowSuccess(true);
                onUploadSuccess();

                // Auto-hide success message after 5 seconds
                setTimeout(() => {
                    setShowSuccess(false);
                    setFile(null);
                    setUploadProgress(0);
                    setTranscodeProgress(0);
                    setStatus("Idle");
                }, 5000);
            }
        });

        socket.on('error', (err) => {
            setError(err || 'Processing failed');
            setIsLoading(false);
            setStatus("Error");
        });

        return () => {
            socket.off('progress');
            socket.off('status');
            socket.off('error');
        };
    }, []);

    return (
        <div style={{ marginBottom: "20px" }}>
            {/* Loading Modal/Overlay */}
            {isLoading && (
                <div
                    style={{
                        position: 'fixed',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: '100%',
                        background: 'rgba(0, 0, 0, 0.7)',
                        display: 'flex',
                        justifyContent: 'center',
                        alignItems: 'center',
                        zIndex: 9999,
                    }}
                >
                    <div
                        style={{
                            background: '#1a1a1a',
                            padding: '40px',
                            borderRadius: '12px',
                            maxWidth: '500px',
                            width: '90%',
                            boxShadow: '0 10px 40px rgba(0, 0, 0, 0.5)',
                            border: '1px solid #bb86fc',
                        }}
                    >
                        {/* File Info */}
                        <h2 style={{ margin: '0 0 20px 0', color: '#bb86fc', fontSize: '20px' }}>
                            📤 {file?.name}
                        </h2>
                        <p style={{ color: '#aaa', marginBottom: '20px', fontSize: '14px' }}>
                            {formatBytes(file?.size)} | Status: {status}
                        </p>

                        {/* Upload Phase */}
                        {uploadProgress < 100 && (
                            <div style={{ marginBottom: '30px' }}>
                                <div style={{ color: '#fff', marginBottom: '8px', fontSize: '14px' }}>
                                    <span>Uploading</span>
                                    <span style={{ float: 'right' }}>
                                        {uploadProgress.toFixed(1)}%
                                    </span>
                                </div>
                                <div
                                    style={{
                                        width: '100%',
                                        height: '8px',
                                        background: '#333',
                                        borderRadius: '4px',
                                        overflow: 'hidden',
                                        marginBottom: '10px',
                                    }}
                                >
                                    <div
                                        style={{
                                            height: '100%',
                                            background: 'linear-gradient(90deg, #bb86fc, #6200ee)',
                                            width: `${uploadProgress}%`,
                                            transition: 'width 0.3s ease',
                                        }}
                                    />
                                </div>
                                <div
                                    style={{
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        fontSize: '12px',
                                        color: '#aaa',
                                    }}
                                >
                                    <span>{formatBytes(uploadedBytesRef.current)} / {formatBytes(file?.size)}</span>
                                    <span>{formatBytes(uploadSpeed)}/s</span>
                                    <span>{formatTime(timeRemaining)}</span>
                                </div>
                            </div>
                        )}

                        {/* Processing Phase */}
                        {uploadProgress >= 100 && transcodeProgress < 100 && (
                            <div style={{ marginBottom: '30px' }}>
                                <div style={{ color: '#fff', marginBottom: '8px', fontSize: '14px' }}>
                                    <span>Processing</span>
                                    <span style={{ float: 'right' }}>
                                        {transcodeProgress.toFixed(0)}%
                                    </span>
                                </div>
                                <div
                                    style={{
                                        width: '100%',
                                        height: '8px',
                                        background: '#333',
                                        borderRadius: '4px',
                                        overflow: 'hidden',
                                    }}
                                >
                                    <div
                                        style={{
                                            height: '100%',
                                            background: 'linear-gradient(90deg, #03dac6, #00bfa5)',
                                            width: `${transcodeProgress}%`,
                                            transition: 'width 0.3s ease',
                                        }}
                                    />
                                </div>
                            </div>
                        )}

                        {/* Spinner */}
                        <div style={{ textAlign: 'center', marginTop: '20px' }}>
                            <div
                                style={{
                                    display: 'inline-block',
                                    width: '30px',
                                    height: '30px',
                                    border: '3px solid #333',
                                    borderTop: '3px solid #bb86fc',
                                    borderRadius: '50%',
                                    animation: 'spin 1s linear infinite',
                                }}
                            />
                            <style>{`
                                @keyframes spin {
                                    0% { transform: rotate(0deg); }
                                    100% { transform: rotate(360deg); }
                                }
                            `}</style>
                        </div>
                    </div>
                </div>
            )}

            {/* Success Notification */}
            {showSuccess && (
                <div
                    style={{
                        position: 'fixed',
                        top: '20px',
                        right: '20px',
                        background: '#4caf50',
                        color: 'white',
                        padding: '16px 24px',
                        borderRadius: '8px',
                        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
                        zIndex: 10000,
                        animation: 'slideIn 0.3s ease-out',
                    }}
                >
                    ✅ Video uploaded and processed successfully!
                    <style>{`
                        @keyframes slideIn {
                            from {
                                transform: translateX(400px);
                                opacity: 0;
                            }
                            to {
                                transform: translateX(0);
                                opacity: 1;
                            }
                        }
                    `}</style>
                </div>
            )}

            {/* Error Notification */}
            {error && (
                <div
                    style={{
                        position: 'fixed',
                        top: '20px',
                        right: '20px',
                        background: '#f44336',
                        color: 'white',
                        padding: '16px 24px',
                        borderRadius: '8px',
                        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
                        zIndex: 10000,
                    }}
                >
                    ❌ Error: {error}
                </div>
            )}

            {/* Upload Controls */}
            <div style={{ marginBottom: "20px" }}>
                <input
                    type="file"
                    id="file-upload"
                    style={{ display: "none" }}
                    onChange={(e) => {
                        setFile(e.target.files[0]);
                        setError(null);
                    }}
                    disabled={isLoading}
                />
                <label
                    htmlFor="file-upload"
                    style={{
                        background: "#333",
                        color: "white",
                        padding: "10px 20px",
                        borderRadius: "8px",
                        cursor: isLoading ? "not-allowed" : "pointer",
                        marginRight: "10px",
                        border: "1px solid #555",
                        opacity: isLoading ? 0.6 : 1,
                        transition: "opacity 0.3s",
                        display: "inline-block",
                    }}
                >
                    {file ? file.name : "📁 Choose File"}
                </label>

                <button
                    onClick={handleUpload}
                    disabled={!file || isLoading}
                    style={{
                        background: file && !isLoading ? "#bb86fc" : "#555",
                        color: "#000",
                        padding: "10px 20px",
                        borderRadius: "8px",
                        border: "none",
                        fontWeight: "bold",
                        cursor: file && !isLoading ? "pointer" : "not-allowed",
                        transition: "background 0.3s",
                        opacity: isLoading ? 0.6 : 1,
                    }}
                >
                    {isLoading ? "⏳ Uploading..." : "Upload Video"}
                </button>
            </div>

            {/* Status Info (when not loading) */}
            {!isLoading && file && (
                <div
                    style={{
                        marginTop: "15px",
                        padding: "10px",
                        background: "#222",
                        borderRadius: "6px",
                        color: "#aaa",
                        fontSize: "13px",
                    }}
                >
                    📎 Selected: <strong>{file.name}</strong> ({formatBytes(file.size)})
                </div>
            )}
        </div>
    );
}