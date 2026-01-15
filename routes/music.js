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

const ytDlpWrap = new YTDlpWrap(); // Let it find system binary or we configure it later

// Global Config
const SPECIFIC_FOLDER_ID = process.env.FOLDER_ID;

// --- GET TRACKS ---
router.get('/tracks', async (req, res) => {
    try {
        const username = req.query.username; // Or from session
        let targetFolderId = SPECIFIC_FOLDER_ID;

        // If user logged in, use their folder
        if (username) {
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
    const { songName, username } = req.body;
    if (!songName) return res.status(400).send('No song name');

    let targetFolder = SPECIFIC_FOLDER_ID;
    if (username) {
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
        // Ensuring yt-dlp is available is crucial here.
        await ytDlpWrap.execPromise([
            video.url,
            '-x', '--audio-format', 'mp3',
            '--ffmpeg-location', ffmpegPath,
            '-o', tempFilePath,
            '--no-check-certificates'
        ]);

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
        res.status(500).send('Download failed');
    }
});

module.exports = router;
