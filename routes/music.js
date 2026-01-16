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
        // 1. Search YouTube for the Link
        console.log(`Searching for: ${songName}`);
        const searchResults = await ytSearch(songName);
        const video = searchResults.videos[0];
        if (!video) return res.status(404).send('Not found');

        console.log(`Found video: ${video.title} (${video.url})`);
        
        // 2. Ask Cobalt for a Clean Download Link
        // We use the official Cobalt API to handle the anti-bot stuff
        const cobaltResponse = await axios.post('https://api.cobalt.tools/api/json', {
            url: video.url,
            vCodec: "h264",
            vQuality: "720",
            aFormat: "mp3",
            isAudioOnly: true
        }, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        });

        // Check if Cobalt gave us a link
        const data = cobaltResponse.data;
        if ((data.status !== 'stream' && data.status !== 'redirect') || !data.url) {
            console.error('Cobalt Response:', data);
            throw new Error('Cobalt could not generate a download link. Try again later.');
        }

        const downloadUrl = data.url;
        console.log(`Cobalt Link Generated. Starting Stream to Drive...`);

        // 3. Stream the File Directly from Cobalt to Google Drive
        // This avoids saving the file to Render's disk, which is faster and safer
        const fileStream = await axios({
            url: downloadUrl,
            method: 'GET',
            responseType: 'stream'
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

        console.log(`✅ Upload Complete: ${driveResponse.data.name}`);
        res.json({ success: true, file: driveResponse.data });

    } catch (error) {
        console.error('Download Failed:', error.message);
        if (error.response) {
            console.error('API Error Data:', error.response.data);
        }
        res.status(500).send('Download failed: ' + error.message);
    }
});

module.exports = router;
