const mongoose = require('mongoose');

const SubtitleSchema = new mongoose.Schema({
    fileId: { type: String, required: true, index: true }, // The Video File ID
    content: { type: String, required: true }, // VTT Content
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Subtitle', SubtitleSchema);
