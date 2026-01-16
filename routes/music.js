const express = require('express');
const router = express.Router();
const { drive } = require('../auth'); // Adjust path if needed
const User = require('../models/User');
const ytSearch = require('yt-search');
const axios = require('axios'); // We use this for Cobalt
const path = require('path');
const os = require('os');

// Global Config
const SPECIFIC_FOLDER_ID = process.env.FOLDER_ID;

// --- GET TRACKS (No changes) ---
router.get('/tracks', async (req, res) => {
    try {
        const { username, folderId } = req.query;
        let targetFolderId = SPECIFIC_FOLDER_ID;

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

// --- LIBRARY: ADD (No changes) ---
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

// --- LIBRARY: REMOVE (No changes) ---
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

// --- LIBRARY: REORDER (No changes) ---
router.post('/library/reorder', async (req, res) => {
    const { folderId, newOrder } = req.body;
    try {
        await User.findOneAndUpdate({ folderId }, { trackOrder: newOrder });
        res.json({ success: true });
    } catch (error) {
        console.error("Reorder Error:", error);
        res.status(500).send("Error reordering");
    }
});

// --- STREAM (No changes) ---
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

// --- NEW DOWNLOAD ROUTE (USING COBALT API) ---
// --- NEW DOWNLOAD ROUTE (USING COBALT API v10) ---
// --- NEW "SMART" DOWNLOAD ROUTE ---
// --- NEW DOWNLOAD ROUTE (USING PIPED API) ---
router.post('/download', async (req, res) => {
    const { songName, username, folderId } = req.body;
    if (!songName) return res.status(400).send('No song name');

    let targetFolder = SPECIFIC_FOLDER_ID;
    if (folderId) {
        targetFolder = folderId;
    } else if (username) {
        const user = await User.findOne({ username });
        if (user) targetFolder = user.folderId;
    }

    try {
        console.log(`Searching Piped Database for: ${songName}`);
        
        // 1. Search for the video ID using Piped API
        // Piped Instances: https://pipedapi.kavin.rocks (Main), https://api.piped.privacy.com.de (Backup)
        const PIPED_API = 'https://pipedapi.kavin.rocks'; 
        
        const searchResponse = await axios.get(`${PIPED_API}/search`, {
            params: {
                q: songName,
                filter: 'music_songs'
            }
        });

        if (!searchResponse.data.items || searchResponse.data.items.length === 0) {
            return res.status(404).send('Song not found in database');
        }

        // Get the first result's ID (e.g., "/watch?v=dQw4w9WgXcQ" -> "dQw4w9WgXcQ")
        const firstResult = searchResponse.data.items[0];
        const videoId = firstResult.url.split('v=')[1];
        const videoTitle = firstResult.title.replace(/[^a-zA-Z0-9]/g, '_'); // Clean title

        console.log(`Found: ${firstResult.title} [${videoId}]`);

        // 2. Fetch the Direct Stream Links
        const streamResponse = await axios.get(`${PIPED_API}/streams/${videoId}`);
        const audioStreams = streamResponse.data.audioStreams;

        if (!audioStreams || audioStreams.length === 0) {
            throw new Error('No audio streams found for this video');
        }

        // 3. Pick the best audio quality (m4a is best for direct streaming)
        // We look for 'm4a' format, or fallback to the first available one
        const bestStream = audioStreams.find(s => s.format === 'M4A') || audioStreams[0];
        
        console.log(`Sourcing from: ${PIPED_API}`);

        // 4. Stream to Drive
        const fileStream = await axios({
            url: bestStream.url,
            method: 'GET',
            responseType: 'stream'
        });

        const media = {
            mimeType: 'audio/mp4', // M4A is technically audio/mp4
            body: fileStream.data
        };

        const driveResponse = await drive.files.create({
            resource: { 
                name: `${videoTitle}.m4a`, // Saving as .m4a (plays in all browsers)
                parents: [targetFolder] 
            },
            media: media,
            fields: 'id, name'
        });

        console.log(`✅ Upload Complete: ${driveResponse.data.name}`);
        res.json({ success: true, file: driveResponse.data });

    } catch (error) {
        console.error('Download Failed:', error.message);
        if (error.response) {
            // Log full API error if available
            console.error('API Status:', error.response.status);
            console.error('API Data:', error.response.data);
        }
        res.status(500).send('Download failed: ' + error.message);
    }
});

module.exports = router;
