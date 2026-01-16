const express = require('express');
const router = express.Router();
const { drive } = require('../auth'); // Adjust path
const Metadata = require('../models/Metadata'); // Require Model directly for Admin
const { fetchMovieMeta, fetchSeriesMeta } = require('../services/metadata');
const https = require('https');

// --- ADMIN ROUTES (Simple PIN Protection) ---
const checkPin = (req, res, next) => {
    if (req.query.pin !== '1234') return res.status(401).json({ error: "Unauthorized" });
    next();
};

router.get('/admin/metadata', checkPin, async (req, res) => {
    const all = await Metadata.find().sort({ _id: -1 }).limit(100);
    res.json(all);
});

router.delete('/admin/metadata/:id', checkPin, async (req, res) => {
    await Metadata.findByIdAndDelete(req.params.id);
    res.json({ success: true });
});

router.post('/admin/metadata/clear', checkPin, async (req, res) => {
    await Metadata.deleteMany({});
    res.json({ success: true, message: "Cache Cleared" });
});
// --------------------------------------------

const driveAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });
const MOVIE_FOLDER_ID = process.env.MOVIE_FOLDER_ID || '1FHOpM5cCOj3CFy3zU5mESc4vhWv_5GIk';
const SERIES_FOLDER_ID = process.env.SERIES_FOLDER_ID || MOVIE_FOLDER_ID; // Fallback
const OTHERS_FOLDER_ID = process.env.OTHERS_FOLDER_ID || MOVIE_FOLDER_ID; // Fallback

// Helper: Concurrency Limiter
async function processWithConcurrency(items, concurrency, fn) {
    const results = [];
    for (let i = 0; i < items.length; i += concurrency) {
        const chunk = items.slice(i, i + concurrency);
        const chunkResults = await Promise.all(chunk.map(fn));
        results.push(...chunkResults);
    }
    return results;
}

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

        // 3. Enrich with Metadata (Batched to prevent OOM/Rate Limits)
        const processFile = async (file) => {
            // 1. Handle VIDEOS
            if (file.mimeType.includes('video')) {
                let meta;
                try {
                    if (category === 'series') {
                        meta = await fetchSeriesMeta(file.name);
                    } else if (category === 'others') {
                        meta = { filename: file.name, title: file.name, poster: '' };
                    } else {
                        meta = await fetchMovieMeta(file.name);
                    }
                } catch (err) {
                    console.error(`Metadata failed for video ${file.name}:`, err.message);
                    meta = { filename: file.name, title: file.name, poster: '' };
                }
                return { ...file, metadata: meta };
            }

            // 2. Handle SERIES FOLDERS (Fetch Meta for the Show)
            // ONLY explicitly if we are at the root (no folderId param)
            else if (category === 'series' && !folderId && file.mimeType === 'application/vnd.google-apps.folder') {
                let meta;
                try {
                    // Verify it's not a season folder (optional, but good practice). 
                    // For now, we assume top-level folders in 'Series' are Shows.
                    meta = await fetchSeriesMeta(file.name);
                } catch (err) {
                    // console.error(`Metadata failed for folder ${file.name}:`, err.message);
                    meta = { filename: file.name, title: file.name, poster: '' };
                }
                return { ...file, metadata: meta };
            }

            return file; // Return other folders/files as is
        };

        // Use concurrency of 3 to stay safe on memory and rate limits
        const enrichedFiles = await processWithConcurrency(response.data.files, 3, processFile);

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
