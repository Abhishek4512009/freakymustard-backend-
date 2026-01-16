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

    // 1. Search YouTube
    let video;
    try {
        console.log(`Searching for: ${songName}`);
        const searchResults = await ytSearch(songName);
        video = searchResults.videos[0];
        if (!video) return res.status(404).send('Not found');
        console.log(`Found: ${video.title}`);
    } catch (e) {
        return res.status(500).send('Search failed: ' + e.message);
    }

    // 2. The "Rotator" Logic
    // We try multiple servers. If one gives a 401/404/500 or HTML error, we skip it.
    const cobaltInstances = [
        'https://cobalt.canine.tools',       // Usually reliable
        'https://cobalt.ducks.party',        // Reliable backup
        'https://cobalt.meowing.de',         // Reliable backup
        'https://api.cobalt.kwiatekmiki.pl', // Backup
        'https://cobalt.xy24.eu'             // Kept as last resort
    ];

    let downloadUrl = null;
    let lastError = null;

    console.log("🚀 Starting Instance Rotation...");

    for (const instance of cobaltInstances) {
        try {
            console.log(`Trying server: ${instance}`);
            const response = await axios.post(instance, {
                url: video.url,
                videoQuality: "720",
                audioFormat: "mp3",
                downloadMode: "audio"
            }, {
                headers: { 
                    'Accept': 'application/json', 
                    'Content-Type': 'application/json',
                    // FAKE USER AGENT to bypass "Anubis" bot protection
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                },
                timeout: 10000 // 10s timeout
            });

            const data = response.data;
            
            // SECURITY CHECK: Ensure we got JSON, not an HTML error page
            if (typeof data === 'string' && data.includes('<html')) {
                throw new Error('Server returned HTML challenge (Bot Blocked)');
            }

            // Check if we got a valid link
            if (data.status === 'stream' || data.status === 'redirect') {
                downloadUrl = data.url;
            } else if (data.status === 'picker' && data.picker) {
                const item = data.picker.find(i => i.type === 'audio') || data.picker[0];
                downloadUrl = item.url;
            }

            if (downloadUrl) {
                console.log(`✅ Success with ${instance}`);
                break; // Stop looping, we found a link!
            }
        } catch (error) {
            const msg = error.response ? `Status ${error.response.status}` : error.message;
            console.warn(`❌ Failed ${instance}: ${msg}`);
            lastError = msg;
            // Loop continues to the next server...
        }
    }

    if (!downloadUrl) {
        return res.status(500).send(`All Cobalt servers failed. Last error: ${lastError}`);
    }

    // 3. Stream to Drive
    try {
        const fileStream = await axios({
            url: downloadUrl,
            method: 'GET',
            responseType: 'stream',
            headers: {
                // Pass the fake User-Agent here too, just in case
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        const media = {
            mimeType: 'audio/mpeg',
            body: fileStream.data
        };

        const driveResponse = await drive.files.create({
            resource: { 
                name: `${video.title}.mp3`, 
                parents: [targetFolder] 
            },
            media: media,
            fields: 'id, name'
        });

        res.json({ success: true, file: driveResponse.data });

    } catch (error) {
        console.error('Upload Error:', error.message);
        res.status(500).send('Upload failed: ' + error.message);
    }
});

module.exports = router;
