require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const connectDB = require('./db');

// Connect to MongoDB
connectDB();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/api/auth', require('./routes/auth_routes')); // Need to create this one actually! I missed it in step 19.
app.use('/api/music', require('./routes/music'));
app.use('/api/movies', require('./routes/movies'));
app.use('/api/subtitles', require('./routes/subtitles'));

// Fallback for SPA (if we use client-side routing, but we are using html files)
// For now, specific HTML mapping
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html'))); // Music
app.get('/movies', (req, res) => res.sendFile(path.join(__dirname, 'public', 'movies.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Unified Streamer running on port ${PORT}`));
