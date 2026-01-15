const express = require('express');
const router = express.Router();
const { drive } = require('../auth'); // Adjust path
const { fetchMovieMeta, fetchSeriesMeta } = require('../services/metadata');
const https = require('https');

const driveAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });
const MOVIE_FOLDER_ID = process.env.MOVIE_FOLDER_ID || '1FHOpM5cCOj3CFy3zU5mESc4vhWv_5GIk';
const SERIES_FOLDER_ID = process.env.SERIES_FOLDER_ID || MOVIE_FOLDER_ID; // Fallback
const OTHERS_FOLDER_ID = process.env.OTHERS_FOLDER_ID || MOVIE_FOLDER_ID; // Fallback

// --- LIST MOVIES/SERIES (Global) ---
router.get('/list', async (req, res) => {
    try {
        const { category, folderId } = req.query;
        let targetFolder = MOVIE_FOLDER_ID;

        // 1. Determine Root Folder based on Category
        if (category === 'series') targetFolder = SERIES_FOLDER_ID;
        else if (category === 'others') targetFolder = OTHERS_FOLDER_ID;

        // 2. If navigating inside a folder, use that specific ID
        if (folderId) targetFolder = folderId;

        const query = `'${targetFolder}' in parents and (mimeType contains 'video' or mimeType = 'application/vnd.google-apps.folder') and trashed = false`;
        
        const response = await drive.files.list({
            q: query,
            fields: 'files(id, name, size, thumbnailLink, mimeType)',
            pageSize: 100
        });

        // 3. Enrich with Metadata (Parallel)
        const enrichedFiles = await Promise.all(response.data.files.map(async (file) => {
            // Only fetch meta for videos, not folders
            if (file.mimeType.includes('video')) {
                let meta;
                if (category === 'series') {
                    meta = await fetchSeriesMeta(file.name);
                } else if (category === 'others') {
                     // For 'others', we might skip or just use movie scraper
                     meta = { filename: file.name, title: file.name, poster: '' };
                } else {
                    meta = await fetchMovieMeta(file.name);
                }
                return { ...file, metadata: meta };
            }
            return file; // Return folder as is
        }));
        
        res.json(enrichedFiles);
    } catch (e) {
        console.error("Movie List Error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// --- TURBO STREAM ---
router.get('/stream/:fileId', async (req, res) => {
    const fileId = req.params.fileId;
    const range = req.headers.range || 'bytes=0-';

    try {
        // 1. Metadata
        const metadata = await drive.files.get({ fileId, fields: 'size, mimeType' });
        const totalSize = parseInt(metadata.data.size);
        let mimeType = metadata.data.mimeType || 'video/mp4';
        if (mimeType === 'video/x-matroska') mimeType = 'video/mp4';

        // 2. Range Headers
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
        const chunkSize = (end - start) + 1;

        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': mimeType,
        });

        // 3. Stream
        const streamResp = await drive.files.get(
            { fileId, alt: 'media', acknowledgeAbuse: true },
            { responseType: 'stream', headers: { 'Range': `bytes=${start}-${end}` }, httpsAgent: driveAgent }
        );

        streamResp.data.pipe(res);
        req.on('close', () => { if (streamResp.data.destroy) streamResp.data.destroy(); });

    } catch (e) {
        console.error('[Movie Stream]', e.message);
        if (!res.headersSent) res.status(500).send("Stream Error");
    }
});

module.exports = router;