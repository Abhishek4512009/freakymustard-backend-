const express = require('express');
const router = express.Router();
const { drive } = require('../auth'); // Adjust path
const User = require('../models/User');
const ytSearch = require('yt-search');
const YTDlpWrap = require('yt-dlp-wrap').default;
const fs = require('fs');
const path = require('path');
const os = require('os');
const ffmpegPath = require('ffmpeg-static');

const binaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const binaryPath = path.join(__dirname, '..', binaryName);
// Note: binaryPath logic might need adjustment if not present, but using default usually works if in path or downloaded.
// Actually, let's use the one from node_modules if possible or expect it in root.
// For now, assume it's set up like Mystream.

console.log(`Checking for yt-dlp binary at: ${binaryPath}`);
if (fs.existsSync(binaryPath)) {
    console.log('✅ yt-dlp binary found at path.');
} else {
    console.error('❌ yt-dlp binary NOT found at path. Postinstall might have failed.');
}

const ytDlpWrap = new YTDlpWrap(binaryPath);

// Global Config
const SPECIFIC_FOLDER_ID = process.env.FOLDER_ID;

// --- GET TRACKS ---
router.get('/tracks', async (req, res) => {
    try {
        const { username, folderId } = req.query;
        let targetFolderId = SPECIFIC_FOLDER_ID;

        // Priority: Explicit folderId > Username's folder > Global Default
        if (folderId) {
            targetFolderId = folderId;
        } else if (username) {
            const user = await User.findOne({ username });
            if (user) targetFolderId = user.folderId;
        }

        const query = `mimeType contains 'audio/' and trashed = false and '${targetFolderId}' in parents`;
        const response = await drive.files.list({
            q: query,
            fields: 'files(id, name, mimeType, size)',
            pageSize: 100,
        });

        let files = response.data.files;

        // --- SORT BY USER PREFERENCE ---
        if (folderId) {
            const user = await User.findOne({ folderId });
            if (user && user.trackOrder && user.trackOrder.length > 0) {
                const orderMap = new Map(user.trackOrder.map((id, index) => [id, index]));
                files.sort((a, b) => {
                    const indexA = orderMap.has(a.id) ? orderMap.get(a.id) : Infinity;
                    const indexB = orderMap.has(b.id) ? orderMap.get(b.id) : Infinity;
                    return indexA - indexB;
                });
            }
        }

        res.json(files);
    } catch (error) {
        console.error("Track Fetch Error:", error.message);
        res.status(500).send('Error fetching tracks');
    }
});

// --- LIBRARY: ADD (Copy File) ---
router.post('/library/add', async (req, res) => {
    const { fileId, folderId } = req.body;
    try {
        await drive.files.copy({
            fileId: fileId,
            resource: { parents: [folderId] }
        });
        res.json({ success: true });
    } catch (error) {
        console.error("Library Add Error:", error);
        res.status(500).send("Error adding to library");
    }
});

// --- LIBRARY: REMOVE (Trash File) ---
router.post('/library/remove', async (req, res) => {
    const { fileId } = req.body;
    try {
        await drive.files.update({
            fileId: fileId,
            resource: { trashed: true }
        });
        res.json({ success: true });
    } catch (error) {
        console.error("Library Remove Error:", error);
        res.status(500).send("Error removing from library");
    }
});

// --- LIBRARY: REORDER ---
router.post('/library/reorder', async (req, res) => {
    const { folderId, newOrder } = req.body;
    try {
        // Find user by folderId (assuming 1:1 map)
        await User.findOneAndUpdate({ folderId }, { trackOrder: newOrder });
        res.json({ success: true });
    } catch (error) {
        console.error("Reorder Error:", error);
        res.status(500).send("Error reordering");
    }
});

// --- STREAM ---
router.get('/stream/:fileId', async (req, res) => {
    const { fileId } = req.params;
    const { range } = req.headers;
    try {
        const meta = await drive.files.get({ fileId, fields: 'size' });
        const fileSize = parseInt(meta.data.size);

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunksize = (end - start) + 1;

            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': 'audio/mpeg',
            });
            const stream = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream', headers: { 'Range': `bytes=${start}-${end}` } });
            stream.data.pipe(res);
        } else {
            res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': 'audio/mpeg' });
            const stream = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
            stream.data.pipe(res);
        }
    } catch (error) {
        console.error('Stream Error:', error.message);
        res.status(500).end();
    }
});

// --- DOWNLOAD (Convert YouTube) ---
// --- DOWNLOAD PROGRESS TRACKING ---
const downloadProgress = new Map(); // Store active downloads: { id: { percent: 0, status: 'downloading' } }

// --- SSE: DOWNLOAD PROGRESS ---
router.get('/progress/:downloadId', (req, res) => {
    const { downloadId } = req.params;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendProgress = () => {
        const progress = downloadProgress.get(downloadId);
        if (progress) {
            res.write(`data: ${JSON.stringify(progress)}\n\n`);
            if (progress.status === 'completed' || progress.status === 'error') {
                downloadProgress.delete(downloadId);
                res.end();
            }
        }
    };

    const interval = setInterval(sendProgress, 500); // Update every 500ms

    req.on('close', () => clearInterval(interval));
});

// --- DOWNLOAD (Async with Progress) ---
router.post('/download', async (req, res) => {
    const { songName, username, folderId } = req.body;
    if (!songName) return res.status(400).send('No song name');

    // 1. Determine Target Folder
    let targetFolder = SPECIFIC_FOLDER_ID;
    if (folderId) targetFolder = folderId;
    else if (username) {
        const user = await User.findOne({ username });
        if (user) targetFolder = user.folderId;
    }

    const downloadId = Date.now().toString(); // Simple unique ID
    downloadProgress.set(downloadId, { percent: 0, status: 'searching' });

    // Return ID immediately
    res.json({ success: true, downloadId });

    // 2. Start Background Process
    (async () => {
        try {
            console.log(`🔎 Searching for: ${songName}`);
            const searchResults = await ytSearch(songName);
            const video = searchResults.videos[0];
            if (!video) {
                downloadProgress.set(downloadId, { percent: 0, status: 'error', message: 'Song not found' });
                return;
            }

            downloadProgress.set(downloadId, { percent: 10, status: 'preparing' });

            const cleanTitle = video.title.replace(/[^a-zA-Z0-9]/g, '_');
            const tempFilePath = path.join(os.tmpdir(), `${cleanTitle}.mp3`);

            // Check Binary
            if (!fs.existsSync(binaryPath)) {
                console.log("⬇️ Downloading yt-dlp binary...");
                await YTDlpWrap.downloadFromGithub(binaryPath);
            }

            // Cookie Logic
            const LOCKED_COOKIES_PATH = '/etc/secrets/cookies.txt';
            const WRITABLE_COOKIES_PATH = path.join(os.tmpdir(), 'cookies.txt');
            if (fs.existsSync(LOCKED_COOKIES_PATH)) {
                try { fs.copyFileSync(LOCKED_COOKIES_PATH, WRITABLE_COOKIES_PATH); } catch (e) { }
            }

            let ytArgs = [
                video.url,
                '-x', '--audio-format', 'mp3',
                '--ffmpeg-location', ffmpegPath,
                '-o', tempFilePath,
                '--no-check-certificates',
                '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            ];
            if (fs.existsSync(WRITABLE_COOKIES_PATH)) ytArgs.push('--cookies', WRITABLE_COOKIES_PATH);

            console.log(`⬇️ Starting download: ${video.title}`);
            const ytDlpEvent = ytDlpWrap.exec(ytArgs);

            ytDlpEvent.on('progress', (progress) => {
                // progress: { percent, totalSize, currentSpeed, eta }
                downloadProgress.set(downloadId, {
                    percent: progress.percent,
                    status: 'downloading',
                    speed: progress.currentSpeed,
                    eta: progress.eta
                });
            });

            ytDlpEvent.on('error', (err) => {
                console.error("yt-dlp error:", err);
                downloadProgress.set(downloadId, { percent: 0, status: 'error', message: 'Download tool failed' });
            });

            ytDlpEvent.on('close', async () => {
                try {
                    console.log(`☁️ Uploading to Drive...`);
                    downloadProgress.set(downloadId, { percent: 99, status: 'uploading' });

                    const media = {
                        mimeType: 'audio/mpeg',
                        body: fs.createReadStream(tempFilePath)
                    };
                    await drive.files.create({
                        resource: { name: `${video.title}.mp3`, parents: [targetFolder] },
                        media: media,
                        fields: 'id, name'
                    });

                    fs.unlinkSync(tempFilePath);
                    downloadProgress.set(downloadId, { percent: 100, status: 'completed', title: video.title });
                    console.log(`✅ Completed: ${video.title}`);
                } catch (err) {
                    console.error("Drive Upload Error:", err);
                    downloadProgress.set(downloadId, { percent: 0, status: 'error', message: 'Upload to Drive failed' });
                }
            });

        } catch (error) {
            console.error("Download Workflow Error:", error);
            downloadProgress.set(downloadId, { percent: 0, status: 'error', message: error.message });
        }
    })();
});

module.exports = router;
