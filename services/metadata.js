const axios = require('axios');
const cheerio = require('cheerio');
const Metadata = require('../models/Metadata');

// Helper: Clean filename to get search query
function cleanFilename(filename) {
    return filename
        .replace(/\.(mp4|mkv|avi|mov)$/i, '') // Remove extension
        .replace(/[._]/g, ' ') // Replace dots/underscores with spaces
        .replace(/\(\d{4}\).*/, '') // Remove year and everything after
        .replace(/1080p|720p|bluray|x264|aac/gi, '') // Remove quality tags
        .trim();
}

// 1. Scrape IMDb (Movies)
async function fetchMovieMeta(filename) {
    // Check Cache
    const cached = await Metadata.findOne({ filename });
    if (cached) return cached;

    const query = cleanFilename(filename);
    console.log(`🎬 Scraping IMDb for: ${query}`);

    try {
        // A. Search IMDb via Google "I'm Feeling Lucky" style or direct search
        // We'll use a direct search on IMDb and parse the first result
        const searchUrl = `https://www.imdb.com/find/?q=${encodeURIComponent(query)}&s=tt&ttype=ft`;
        const { data: searchHtml } = await axios.get(searchUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
        });

        const $ = cheerio.load(searchHtml);
        // Find first result link (href contains /title/tt...)
        const firstResult = $('.ipc-metadata-list-summary-item__t').first().attr('href');

        if (!firstResult) throw new Error('No results on IMDb');

        // B. Fetch Movie Page
        const moviePageUrl = `https://www.imdb.com${firstResult}`;
        const { data: movieHtml } = await axios.get(moviePageUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
        });

        const $movie = cheerio.load(movieHtml);

        // C. Extract Data (Open Graph tags are consistent)
        const meta = {
            filename,
            title: $('meta[property="og:title"]').attr('content') || query,
            poster: $('meta[property="og:image"]').attr('content') || '',
            description: $('meta[property="og:description"]').attr('content') || '',
            type: 'movie'
        };

        // Save to DB
        const newMeta = new Metadata(meta);
        await newMeta.save();
        return newMeta;

    } catch (e) {
        console.error(`❌ Metadata Error (${filename}):`, e.message);
        return { filename, title: query, poster: '' }; // Return basic fallback
    }
}

// 2. TVMaze (Series)
async function fetchSeriesMeta(filename) {
    // Check Cache
    const cached = await Metadata.findOne({ filename });
    if (cached) return cached;

    const query = cleanFilename(filename);
    console.log(`📺 Fetching TVMaze for: ${query}`);

    try {
        const url = `https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(query)}`;
        const { data } = await axios.get(url);

        const meta = {
            filename,
            title: data.name,
            poster: data.image ? data.image.medium : '', // or .original for high res
            description: data.summary ? data.summary.replace(/<[^>]*>/g, '') : '', // Strip HTML
            year: data.premiered ? data.premiered.split('-')[0] : '',
            type: 'series'
        };

        // Save to DB
        const newMeta = new Metadata(meta);
        await newMeta.save();
        return newMeta;

    } catch (e) {
        console.error(`❌ Metadata Error (${filename}):`, e.message);
        return { filename, title: query, poster: '' };
    }
}

module.exports = { fetchMovieMeta, fetchSeriesMeta };