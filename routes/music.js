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

        res.json(response.data.files);
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
router.post('/download', async (req, res) => {
    const { songName, username, folderId } = req.body; // Accept folderId directly
    if (!songName) return res.status(400).send('No song name');

    let targetFolder = SPECIFIC_FOLDER_ID;
    if (folderId) {
        targetFolder = folderId;
    } else if (username) {
        const user = await User.findOne({ username });
        if (user) targetFolder = user.folderId;
    }

    try {
        const searchResults = await ytSearch(songName);
        const video = searchResults.videos[0];
        if (!video) return res.status(404).send('Not found');

        const cleanTitle = video.title.replace(/[^a-zA-Z0-9]/g, '_');
        const tempFilePath = path.join(os.tmpdir(), `${cleanTitle}.mp3`);

        // Download logic
        // Download logic

        // Cookie Logic (Ported from old server)
        const LOCKED_COOKIES_PATH = '/etc/secrets/cookies.txt';
        const WRITABLE_COOKIES_PATH = path.join(os.tmpdir(), 'cookies.txt');

        if (fs.existsSync(LOCKED_COOKIES_PATH)) {
            try {
                fs.copyFileSync(LOCKED_COOKIES_PATH, WRITABLE_COOKIES_PATH);
                console.log(`✅ Cookies loaded for ${video.videoId}`);
            } catch (e) {
                console.error("⚠️ Failed to copy cookies:", e);
            }
        }

        let ytArgs = [
            video.url,
            '-x', '--audio-format', 'mp3',
            '--ffmpeg-location', ffmpegPath,
            '-o', tempFilePath,
            '--no-check-certificates',
            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            //   '--js-runtimes', 'node' // Attempt to fix JS warning
        ];

        if (fs.existsSync(WRITABLE_COOKIES_PATH)) {
            ytArgs.push('--cookies', WRITABLE_COOKIES_PATH);
        }

        await ytDlpWrap.execPromise(ytArgs);

        const media = {
            mimeType: 'audio/mpeg',
            body: fs.createReadStream(tempFilePath)
        };
        const driveResponse = await drive.files.create({
            resource: { name: `${video.title}.mp3`, parents: [targetFolder] },
            media: media,
            fields: 'id, name'
        });

        fs.unlinkSync(tempFilePath);
        res.json({ success: true, file: driveResponse.data });
    } catch (error) {
        console.error('Download Failed:', error);
        res.status(500).send('Download failed: ' + error.message);
    }
});

module.exports = router;
