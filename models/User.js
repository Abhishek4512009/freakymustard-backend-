const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    folderId: { type: String, required: true }, // Personal Music Folder ID
    trackOrder: { type: [String], default: [] } // Song sorting preference
});

module.exports = mongoose.model('User', UserSchema);
