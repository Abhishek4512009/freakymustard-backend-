const axios = require('axios');
const cheerio = require('cheerio');
const Metadata = require('../models/Metadata');

// Helper: Aggressive Filename Cleaning
function cleanFilename(filename) {
    let name = filename;
    
    // 1. Remove Extension
    name = name.replace(/\.(mp4|mkv|avi|mov|webp)$/i, '');
    
    // 2. Replace dots/underscores/hyphens/parentheses with spaces
    name = name.replace(/[._\-()]/g, ' ');

    // 3. Extract Show Name (Stop at S01, E01, Season, Episode)
    const seasonMatch = name.match(/S\d{1,2}E\d{1,2}/i) || 
                        name.match(/Season \d+/i) || 
                        name.match(/Episode \d+/i);
    
    if (seasonMatch) {
        return name.substring(0, seasonMatch.index).trim();
    }

    // 4. Clean Movie Name
    const stopWords = [
        '1080p', '720p', '2160p', '4k', '5.1', 'web-dl', 'webrip', 'bluray', 
        'x264', 'x265', 'hevc', 'hdr', 'aac', 'yify', 'yts', 'galaxy', 'bone', 
        'h264', 'h265', '10bit', 'ddp5', 'dd5', 'esub', 'repack', 'rmteam', 'hcsubbed'
    ];
    
    const yearMatch = name.match(/\b(19|20)\d{2}\b/);
    if (yearMatch) {
        const yearIndex = yearMatch.index;
        const potentialName = name.substring(0, yearIndex + 4).trim();
        return potentialName.replace(/\s+/g, ' '); 
    }

    for (const word of stopWords) {
        const idx = name.toLowerCase().indexOf(word);
        if (idx !== -1) {
            name = name.substring(0, idx);
        }
    }

    return name.replace(/\s+/g, ' ').trim();
}

async function scrapeIMDb(query) {
    console.log(`🎬 Scraping IMDb for: "${query}"`);
    const searchUrl = `https://www.imdb.com/find/?q=${encodeURIComponent(query)}&s=tt&ttype=ft`;
    
    // Use aggressive headers to look like a real browser
    const { data: searchHtml } = await axios.get(searchUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Referer': 'https://www.google.com/'
        }
    });

    const $ = cheerio.load(searchHtml);
    
    // Robust Selector: Find any link containing /title/tt
    // The previous specific class selector became invalid.
    let firstResultLink = null;
    $('a[href*="/title/tt"]').each((i, el) => {
        const href = $(el).attr('href');
        if (href && href.match(/\/title\/tt\d+/)) {
            firstResultLink = href;
            return false; // Break loop
        }
    });

    if (!firstResultLink) throw new Error('No results');

    const moviePageUrl = `https://www.imdb.com${firstResultLink}`;
    const { data: movieHtml } = await axios.get(moviePageUrl, {
        headers: { 
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9'
        }
    });

    const $movie = cheerio.load(movieHtml);
    return {
        title: $movie('meta[property="og:title"]').attr('content') || query,
        poster: $movie('meta[property="og:image"]').attr('content') || '',
        description: $movie('meta[property="og:description"]').attr('content') || '',
        type: 'movie'
    };
}

// 1. Scrape IMDb (Movies)
async function fetchMovieMeta(filename) {
    const cached = await Metadata.findOne({ filename });
    if (cached) return cached;

    const query = cleanFilename(filename);
    let metaData = { filename, title: query, poster: '' };

    try {
        // Attempt 1: With cleaned name (potentially including year)
        const scraped = await scrapeIMDb(query);
        metaData = { ...scraped, filename };
    } catch (e) {
        // Attempt 2: If failed and had a year, try without year
        const yearMatch = query.match(/\b(19|20)\d{2}\b/);
        if (yearMatch) {
            const noYearQuery = query.replace(yearMatch[0], '').trim();
            if (noYearQuery.length > 2) {
                try {
                    console.log(`   ⚠ Retry without year: "${noYearQuery}"`);
                    const scraped = await scrapeIMDb(noYearQuery);
                    metaData = { ...scraped, filename };
                } catch (retryErr) {
                    console.error(`   ❌ Failed both attempts for: ${filename}`);
                }
            }
        } else {
             console.error(`   ❌ Failed to scrape: ${filename} (${e.message})`);
        }
    }

    const newMeta = new Metadata(metaData);
    await newMeta.save();
    return newMeta;
}

// 2. TVMaze (Series)
async function fetchSeriesMeta(filename) {
    const cached = await Metadata.findOne({ filename });
    if (cached) return cached;

    let showName = cleanFilename(filename).replace(/\s(19|20)\d{2}$/, '').trim();
    
    // Extract Episode Info for Display
    const episodeMatch = filename.match(/S(\d{1,2})E(\d{1,2})/i);
    let episodeTag = '';
    if (episodeMatch) {
        episodeTag = ` S${episodeMatch[1].padStart(2, '0')}E${episodeMatch[2].padStart(2, '0')}`;
    }

    console.log(`📺 Fetching TVMaze for: "${showName}"`);

    try {
        const url = `https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(showName)}`;
        const { data } = await axios.get(url);

        const meta = {
            filename,
            title: data.name + episodeTag, 
            poster: data.image ? data.image.medium : '', 
            description: data.summary ? data.summary.replace(/<[^>]*>/g, '') : '', 
            year: data.premiered ? data.premiered.split('-')[0] : '',
            type: 'series'
        };

        const newMeta = new Metadata(meta);
        await newMeta.save();
        return newMeta;

    } catch (e) {
        console.error(`   ❌ TVMaze Error (${showName}):`, e.message);
        return { filename, title: showName + episodeTag, poster: '' };
    }
}

module.exports = { fetchMovieMeta, fetchSeriesMeta };