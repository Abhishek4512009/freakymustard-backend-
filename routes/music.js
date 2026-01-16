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
// --- DYNAMIC INSTANCE MANAGER ---
// Fetches the list of active Piped servers so you don't rely on just one.
let cachedInstances = [];
let lastFetchTime = 0;
const INSTANCE_LIST_URL = 'https://raw.githubusercontent.com/WikiMobile/piped-instances/main/instances.json';

// Backup list if GitHub is down
const FALLBACK_INSTANCES = [
    'https://pipedapi.kavin.rocks',
    'https://api.piped.privacy.com.de',
    'https://pipedapi.drgns.space',
    'https://api.piped.iot.si',
    'https://api.piped.projectsegfau.lt'
];

async function getWorkingInstances() {
    const now = Date.now();
    // Refresh list every 1 hour (3600000 ms)
    if (cachedInstances.length > 0 && (now - lastFetchTime) < 3600000) {
        return cachedInstances;
    }

    try {
        console.log('🔄 Fetching fresh Piped instances...');
        const response = await axios.get(INSTANCE_LIST_URL, { timeout: 5000 });
        
        // Filter for servers marked as "up" and extract their API URL
        const freshList = response.data
            .filter(i => i.api_url && i.up === true)
            .map(i => i.api_url);

        if (freshList.length > 0) {
            cachedInstances = freshList;
            lastFetchTime = now;
            console.log(`✅ Updated instance list. Found ${freshList.length} working servers.`);
            return freshList;
        }
    } catch (error) {
        console.warn('⚠️ Failed to fetch dynamic list, using fallbacks:', error.message);
    }

    return FALLBACK_INSTANCES;
}

// --- SMART DOWNLOAD ROUTE ---
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

    let downloadUrl = null;
    let videoTitle = '';
    let lastError = null;

    try {
        // 1. Get working servers
        const instances = await getWorkingInstances();
        console.log(`🔍 Searching for: ${songName}`);

        // 2. ROTATION LOGIC: Try servers one by one until one works
        for (const apiBase of instances) {
            try {
                // Step A: Search for the video
                const searchResponse = await axios.get(`${apiBase}/search`, {
                    params: { q: songName, filter: 'music_songs' },
                    timeout: 6000 // 6s timeout per server
                });

                if (!searchResponse.data.items || searchResponse.data.items.length === 0) continue;

                const firstResult = searchResponse.data.items[0];
                const videoId = firstResult.url.split('v=')[1];
                videoTitle = firstResult.title.replace(/[^a-zA-Z0-9]/g, '_'); // Clean title

                console.log(`Found on ${apiBase}: ${firstResult.title}`);

                // Step B: Get the direct stream link
                const streamResponse = await axios.get(`${apiBase}/streams/${videoId}`, { timeout: 6000 });
                const audioStreams = streamResponse.data.audioStreams;

                if (audioStreams && audioStreams.length > 0) {
                    // Success! Pick 'm4a' or first available audio
                    const bestStream = audioStreams.find(s => s.format === 'M4A') || audioStreams[0];
                    downloadUrl = bestStream.url;
                    break; // STOP LOOPING, WE FOUND IT!
                }
            } catch (e) {
                // Silent fail on this server, loop continues to the next one
                lastError = e.message;
            }
        }

        if (!downloadUrl) {
            return res.status(500).send('All servers failed. Last error: ' + lastError);
        }

        // 3. Stream to Drive
        console.log(`⬇️ Streaming to Drive...`);
        const fileStream = await axios({
            url: downloadUrl,
            method: 'GET',
            responseType: 'stream'
        });

        const media = {
            mimeType: 'audio/mp4', // M4A
            body: fileStream.data
        };

        const driveResponse = await drive.files.create({
            resource: { name: `${videoTitle}.m4a`, parents: [targetFolder] },
            media: media,
            fields: 'id, name'
        });

        console.log(`✅ Upload Complete: ${driveResponse.data.name}`);
        res.json({ success: true, file: driveResponse.data });

    } catch (error) {
        console.error('System Error:', error.message);
        res.status(500).send('System error: ' + error.message);
    }
});

module.exports = router;
