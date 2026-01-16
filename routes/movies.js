const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const Metadata = require('../models/Metadata');
const { fetchMovieMeta, fetchSeriesMeta } = require('../services/metadata');

const auth = new google.auth.GoogleAuth({
    keyFile: 'credentials.json',
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
});
const drive = google.drive({ version: 'v3', auth });

const MOVIE_FOLDER_ID = process.env.MOVIE_FOLDER_ID;
const SERIES_FOLDER_ID = process.env.SERIES_FOLDER_ID;
const OTHERS_FOLDER_ID = process.env.OTHERS_FOLDER_ID;
const ADMIN_PIN = '1234'; // Simple Hardcoded PIN

// --- ADMIN MIDDLEWARE ---
const checkPin = (req, res, next) => {
    if (req.query.pin === ADMIN_PIN) next();
    else res.status(403).json({ error: "Invalid PIN" });
};

// --- LIST MOVIES ---
router.get('/list', async (req, res) => {
    try {
        const category = req.query.category || 'movies';
        const folderId = req.query.folderId; // Support navigating inside folders

        let targetFolderId = MOVIE_FOLDER_ID;
        if (folderId) targetFolderId = folderId; // If browsing a subfolder
        else if (category === 'series') targetFolderId = SERIES_FOLDER_ID;
        else if (category === 'others') targetFolderId = OTHERS_FOLDER_ID;

        const response = await drive.files.list({
            q: `'${targetFolderId}' in parents and trashed = false`,
            fields: 'files(id, name, mimeType, thumbnailLink, size)',
            orderBy: 'name',
            pageSize: 100
        });

        // Enrich with Metadata
        const enrichedFiles = await Promise.all(response.data.files.map(async (file) => {
            if (file.mimeType === 'application/vnd.google-apps.folder') return file; // Folders don't need metadata yet

            if (category === 'movies') {
                const meta = await fetchMovieMeta(file.name);
                return { ...file, metadata: meta };
            } else if (category === 'series') {
                const meta = await fetchSeriesMeta(file.name);
                return { ...file, metadata: meta };
            }
            return file;
        }));

        res.json(enrichedFiles);
    } catch (error) {
        console.error(error);
        res.status(500).send("Error fetching movies");
    }
});

// --- ADMIN ROUTES ---
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

module.exports = router;
