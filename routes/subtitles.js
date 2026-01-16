const express = require('express');
const router = express.Router();
const Subtitle = require('../models/Subtitle');
const multer = require('multer');

// Use memory storage for ephemeral upload handling before Mongo save
const upload = multer({ storage: multer.memoryStorage() });

// --- UPLOAD SUBTITLE ---
router.post('/upload/:fileId', upload.single('subtitle'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file" });

        let content = req.file.buffer.toString('utf-8');

        // --- SUBTITLE CONVERSION (SRT -> VTT) ---
        // 1. If it doesn't start with WEBVTT, add it.
        if (!content.trim().startsWith('WEBVTT')) {
            content = 'WEBVTT\n\n' + content;
        }

        // 2. Convert Comma timestamps (00:00:00,000) to Dot (00:00:00.000)
        // Regex looks for HH:MM:SS,MMM pattern
        content = content.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
        // ----------------------------------------

        // Upsert subtitle for this video
        await Subtitle.findOneAndUpdate(
            { fileId: req.params.fileId },
            { content: content, createdAt: Date.now() },
            { upsert: true, new: true }
        );

        res.json({ success: true, message: "Subtitle saved" });
    } catch (error) {
        console.error("Subtitle Upload Error:", error);
        res.status(500).json({ error: "Failed to save subtitle" });
    }
});

// --- GET SUBTITLE ---
router.get('/:fileId', async (req, res) => {
    try {
        const sub = await Subtitle.findOne({ fileId: req.params.fileId });
        if (sub) {
            res.setHeader('Content-Type', 'text/vtt');
            res.send(sub.content);
        } else {
            // Return empty header so player doesn't crash
            res.setHeader('Content-Type', 'text/vtt');
            res.send('WEBVTT\n\n');
        }
    } catch (error) {
        res.status(500).send("Error");
    }
});

const { searchSubtitles } = require('../services/sub_scraper');
const AdmZip = require('adm-zip');
const axios = require('axios');

// --- SEARCH & AUTO-SYNC SUBTITLES ---
router.get('/search', async (req, res) => {
    const { query, fileId } = req.query;
    if (!query || !fileId) return res.status(400).json({ error: "Missing params" });

    try {
        // 1. Find Subtitle URL
        const result = await searchSubtitles(query);
        if (!result) return res.json({ success: false, message: "Not found" });

        console.log(`📥 Downloading subtitle from: ${result.url}`);

        // 2. Download File
        const response = await axios.get(result.url, { responseType: 'arraybuffer' });
        const buffer = response.data;

        let srtContent = null;

        // 3. Extract if ZIP
        if (result.isZip || result.url.endsWith('.zip')) {
            const zip = new AdmZip(buffer);
            const zipEntries = zip.getEntries();

            // Find first .srt file
            const srtEntry = zipEntries.find(entry => entry.entryName.endsWith('.srt'));

            if (srtEntry) {
                srtContent = srtEntry.getData().toString('utf8');
            } else {
                // If no SRT, maybe VTT?
                const vttEntry = zipEntries.find(entry => entry.entryName.endsWith('.vtt'));
                if (vttEntry) srtContent = vttEntry.getData().toString('utf8');
            }
        } else {
            // Assume direct text if not zip
            srtContent = buffer.toString('utf8');
        }

        if (!srtContent) return res.json({ success: false, message: "No text subtitle found in archive" });

        // 4. Convert to VTT (Reuse logic)
        let vttContent = srtContent;
        if (!vttContent.trim().startsWith('WEBVTT')) {
            vttContent = 'WEBVTT\n\n' + vttContent;
        }
        vttContent = vttContent.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');

        // 5. Save to DB
        await Subtitle.findOneAndUpdate(
            { fileId: fileId },
            { content: vttContent, createdAt: Date.now() },
            { upsert: true, new: true }
        );

        // 6. Return URL to fetch it
        res.json({ success: true, vttUrl: `${process.env.PUBLIC_URL || ''}/api/subtitles/${fileId}` });

    } catch (error) {
        console.error("Subtitle Auto-Sync Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
