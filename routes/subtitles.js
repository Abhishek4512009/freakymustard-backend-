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

module.exports = router;
