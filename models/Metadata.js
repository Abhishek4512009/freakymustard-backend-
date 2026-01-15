const mongoose = require('mongoose');

const MetadataSchema = new mongoose.Schema({
    filename: { type: String, required: true, unique: true }, // Key
    title: { type: String },
    poster: { type: String },
    backdrop: { type: String },
    description: { type: String },
    year: { type: String },
    type: { type: String, enum: ['movie', 'series'], default: 'movie' },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Metadata', MetadataSchema);