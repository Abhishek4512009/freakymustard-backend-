const axios = require('axios');
const cheerio = require('cheerio');
const Metadata = require('../models/Metadata');

// Helper: Aggressive Filename Cleaning
function cleanFilename(filename) {
    let name = filename;
    
    // 1. Remove Extension
    name = name.replace(/\.(mp4|mkv|avi|mov|webp)$/i, '');
    
    // 2. Replace dots/underscores/hyphens with spaces
    name = name.replace(/[._-]/g, ' ');

    // 3. Extract Show Name (Stop at S01, E01, etc.)
    const seasonMatch = name.match(/S\d{1,2}E\d{1,2}/i) || name.match(/Season \d+/i);
    if (seasonMatch) {
        return name.substring(0, seasonMatch.index).trim();
    }

    // 4. Extract Movie Name (Stop at Year or Quality)
    // Common stopwords
    const stopWords = [
        '1080p', '720p', '2160p', '4k', '5.1', 'web-dl', 'webrip', 'bluray', 'x264', 'x265', 'hevc', 'hdr', 'aac', 'yify', 'yts', 'galaxy', 'bone'
    ];
    
    // Regex for 4-digit year (19xx or 20xx)
    const yearMatch = name.match(/\b(19|20)\d{2}\b/);
    if (yearMatch) {
         // Keep the year for movies as it helps accuracy
        return name.substring(0, yearMatch.index + 4).trim(); 
    }

    // If no year, cut at first stopword
    for (const word of stopWords) {
        const idx = name.toLowerCase().indexOf(word);
        if (idx !== -1) {
            name = name.substring(0, idx);
        }
    }

    return name.trim();
}

// 1. Scrape IMDb (Movies)
async function fetchMovieMeta(filename) {
    // Check Cache
    const cached = await Metadata.findOne({ filename });
    if (cached) return cached;

    const query = cleanFilename(filename);
    console.log(`🎬 Scraping IMDb for: ${query} (Original: ${filename})`);

    try {
        // Direct search on Google to find IMDb ID (More reliable than IMDb search bar)
        // Note: Using a lightweight HTML search on Google is often blocked. 
        // Let's stick to IMDb but try 'ADVANCED' search URL structure which is often cleaner.
        
        const searchUrl = `https://www.imdb.com/find/?q=${encodeURIComponent(query)}&s=tt&ttype=ft`;
        const { data: searchHtml } = await axios.get(searchUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) width=1920 height=1080' }
        });

        const $ = cheerio.load(searchHtml);
        
        // IMDb's class names change. Try robust selectors.
        // 1. List items in search results
        const firstResultLink = $('.ipc-metadata-list-summary-item__t').first().attr('href');
        
        if (!firstResultLink) {
            console.log("   -> No results on IMDb search page.");
            throw new Error('No results');
        }

        // B. Fetch Movie Page
        const moviePageUrl = `https://www.imdb.com${firstResultLink}`;
        const { data: movieHtml } = await axios.get(moviePageUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) width=1920 height=1080' }
        });

        const $movie = cheerio.load(movieHtml);

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
        return { filename, title: query, poster: '' }; 
    }
}

// 2. TVMaze (Series)
async function fetchSeriesMeta(filename) {
    const cached = await Metadata.findOne({ filename });
    if (cached) return cached;

    const query = cleanFilename(filename); // Now returns just "Fallout" or "Breaking Bad"
    console.log(`📺 Fetching TVMaze for: ${query} (Original: ${filename})`);

    try {
        const url = `https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(query)}`;
        const { data } = await axios.get(url);

        const meta = {
            filename,
            title: data.name, // Just use Show Name (e.g. "Fallout")
            poster: data.image ? data.image.medium : '',
            description: data.summary ? data.summary.replace(/<[^>]*>/g, '') : '', 
            year: data.premiered ? data.premiered.split('-')[0] : '',
            type: 'series'
        };

        // Save to DB
        const newMeta = new Metadata(meta);
        await newMeta.save();
        return newMeta;

    } catch (e) {
        console.error(`❌ Metadata Error (${filename}):`, e.message);
        // Fallback: title is the cleaned show name
        return { filename, title: query, poster: '' };
    }
}

module.exports = { fetchMovieMeta, fetchSeriesMeta };