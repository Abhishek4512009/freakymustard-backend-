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
    // Common stopwords
    const stopWords = [
        '1080p', '720p', '2160p', '4k', '5.1', 'web-dl', 'webrip', 'bluray', 
        'x264', 'x265', 'hevc', 'hdr', 'aac', 'yify', 'yts', 'galaxy', 'bone', 
        'h264', 'h265', '10bit', 'ddp5', 'dd5', 'esub', 'repack', 'rmteam', 'hcsubbed'
    ];
    
    // Regex for 4-digit year (19xx or 20xx)
    const yearMatch = name.match(/\b(19|20)\d{2}\b/);
    if (yearMatch) {
        // e.g. "Fight Club 1999 REPACK..." -> "Fight Club 1999"
        const yearIndex = yearMatch.index;
        const potentialName = name.substring(0, yearIndex + 4).trim();
        // Return cleaned name with year
        return potentialName.replace(/\s+/g, ' '); 
    }

    // If no year, cut at first stopword
    for (const word of stopWords) {
        const idx = name.toLowerCase().indexOf(word);
        if (idx !== -1) {
            name = name.substring(0, idx);
        }
    }

    return name.replace(/\s+/g, ' ').trim();
}

// 1. Scrape IMDb (Movies)
async function fetchMovieMeta(filename) {
    const cached = await Metadata.findOne({ filename });
    if (cached) return cached;

    const query = cleanFilename(filename);
    console.log(`🎬 Scraping IMDb for: "${query}" (Original: ${filename})`);

    try {
        // Use IMDb 'find' endpoint with aggressive browser headers
        const searchUrl = `https://www.imdb.com/find/?q=${encodeURIComponent(query)}&s=tt&ttype=ft`;
        const { data: searchHtml } = await axios.get(searchUrl, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
            }
        });

        const $ = cheerio.load(searchHtml);
        // Robust Selector for first movie result
        const firstResultLink = $('.ipc-metadata-list-summary-item__t').first().attr('href');
        
        if (!firstResultLink) {
            console.log(`   ❌ No results found on IMDb for: "${query}"`);
            throw new Error('No results');
        }

        const moviePageUrl = `https://www.imdb.com${firstResultLink}`;
        const { data: movieHtml } = await axios.get(moviePageUrl, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        const $movie = cheerio.load(movieHtml);

        const meta = {
            filename,
            title: $('meta[property="og:title"]').attr('content') || query,
            poster: $('meta[property="og:image"]').attr('content') || '',
            description: $('meta[property="og:description"]').attr('content') || '',
            type: 'movie'
        };

        const newMeta = new Metadata(meta);
        await newMeta.save();
        return newMeta;

    } catch (e) {
        // console.error(`   ❌ Scraping Error:`, e.message);
        return { filename, title: query, poster: '' }; 
    }
}

// 2. TVMaze (Series)
async function fetchSeriesMeta(filename) {
    const cached = await Metadata.findOne({ filename });
    if (cached) return cached;

    let query = cleanFilename(filename);
    
    // Series often have years in filename "Fallout 2024" but API wants "Fallout"
    // Heuristic: remove year from end if present
    const cleanQuery = query.replace(/\s(19|20)\d{2}$/, '').trim();
    
    console.log(`📺 Fetching TVMaze for: "${cleanQuery}" (derived from "${query}")`);

    try {
        const url = `https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(cleanQuery)}`;
        const { data } = await axios.get(url);

        const meta = {
            filename,
            title: data.name,
            poster: data.image ? data.image.medium : '', 
            description: data.summary ? data.summary.replace(/<[^>]*>/g, '') : '', 
            year: data.premiered ? data.premiered.split('-')[0] : '',
            type: 'series'
        };

        const newMeta = new Metadata(meta);
        await newMeta.save();
        return newMeta;

    } catch (e) {
        console.error(`   ❌ TVMaze Error (${cleanQuery}):`, e.message);
        return { filename, title: query, poster: '' };
    }
}

module.exports = { fetchMovieMeta, fetchSeriesMeta };