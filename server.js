require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const connectDB = require('./db');

// Connect to MongoDB
const YTDlpWrap = require('yt-dlp-wrap').default;
const fs = require('fs');

// Connect to MongoDB
connectDB();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', require('./routes/auth_routes'));
app.use('/api/music', require('./routes/music'));
app.use('/api/movies', require('./routes/movies'));
app.use('/api/subtitles', require('./routes/subtitles'));

// Base Route
app.get('/', (req, res) => res.send('🚀 FreakyMustard Backend is Running!'));

const PORT = process.env.PORT || 3000;

// Start Server
app.listen(PORT, () => {
    console.log(`🚀 Unified Streamer running on port ${PORT}`);

    // --- KEEP-ALIVE HEARTBEAT ---
    // Pings the public URL to ensure Render's load balancer sees activity
    const https = require('https');
    setInterval(() => {
        https.get('https://freakymustard.onrender.com', (res) => {
            // console.log('💓 Heartbeat sent to public URL');
        }).on('error', (err) => {
            console.error('Heartbeat failed:', err.message);
        });
    }, 5 * 60 * 1000); // 5 Minutes
});