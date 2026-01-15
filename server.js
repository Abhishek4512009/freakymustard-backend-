require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const connectDB = require('./db');
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

// Ensure yt-dlp binary exists
const ensureYtDlp = async () => {
    const binaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    const binaryPath = path.join(__dirname, binaryName);
    
    if (!fs.existsSync(binaryPath)) {
        console.log('⚠️ yt-dlp binary not found. Downloading...');
        try {
            await YTDlpWrap.downloadFromGithub(binaryPath);
            console.log('✅ yt-dlp downloaded successfully!');
            if (process.platform !== 'win32') {
                fs.chmodSync(binaryPath, '755');
            }
        } catch (err) {
            console.error('❌ Failed to download yt-dlp:', err);
        }
    } else {
        console.log('✅ yt-dlp binary found.');
    }
};

// Start Server
ensureYtDlp().then(() => {
    app.listen(PORT, () => console.log(`🚀 Unified Streamer running on port ${PORT}`));
});