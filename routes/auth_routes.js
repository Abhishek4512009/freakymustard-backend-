const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { drive } = require('../auth');

// Env
const SPECIFIC_FOLDER_ID = process.env.FOLDER_ID;

// --- REGISTER ---
router.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: "Missing fields" });

        const existing = await User.findOne({ username });
        if (existing) return res.status(400).json({ error: "Username taken" });

        // Create Personal Folder
        const folderMetadata = {
            name: `mystream_${username}`,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [SPECIFIC_FOLDER_ID]
        };
        const driveRes = await drive.files.create({
            resource: folderMetadata,
            fields: 'id'
        });
        const newFolderId = driveRes.data.id;

        // Save User
        const newUser = new User({ username, password, folderId: newFolderId });
        await newUser.save();

        res.json({ success: true, folderId: newFolderId });
    } catch (err) {
        console.error("Register Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// --- LOGIN ---
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });

        if (!user || user.password !== password) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        res.json({ success: true, folderId: user.folderId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
