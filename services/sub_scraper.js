const axios = require('axios');
const cheerio = require('cheerio');

async function searchSubtitles(query) {
    try {
        console.log(`🎬 Scraper: Searching YTS for "${query}"...`);
        // 1. Search YTS for the Movie to get IMDB ID
        const ytsRes = await axios.get(`https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}`);

        if (!ytsRes.data || !ytsRes.data.data.movies || ytsRes.data.data.movies.length === 0) {
            console.log("❌ No movie found on YTS.");
            return null;
        }

        const movie = ytsRes.data.data.movies[0];
        const imdbCode = movie.imdb_code;
        const titleSlug = movie.slug; // often used in URLs

        if (!imdbCode) return null;

        console.log(`✅ Found IMDB: ${imdbCode} (${movie.title})`);

        // 2. Scrape YIFY Subtitles for English Subs
        // Try direct URL pattern: yifysubtitles.ch/movie-imdb/{imdbCode}
        // Note: The domain/pattern shifts often. Using a common one.
        const scrapeUrl = `https://yifysubtitles.ch/movie-imdb/${imdbCode}`;

        const subPage = await axios.get(scrapeUrl, { validateStatus: false });

        if (subPage.status !== 200) {
            console.log(`❌ Subtitle page unreachable: ${scrapeUrl}`);
            return null;
        }

        const $ = cheerio.load(subPage.data);

        // Find first English subtitle
        // Structure usually: <tr> with .flag-cell .flag-us or similar
        // For simplicity, we look for 'English' text and the associated download link

        let downloadPath = null;

        $('.high-rating').each((i, el) => {
            const lang = $(el).find('.sub-lang').text().trim();
            if (lang === 'English') {
                const link = $(el).find('.subtitle-download').attr('href');
                if (link) {
                    downloadPath = link;
                    return false; // break
                }
            }
        });

        if (!downloadPath) {
            // Fallback search
            $('tr').each((i, el) => {
                const text = $(el).text();
                if (text.includes('English')) {
                    const link = $(el).find('a').attr('href');
                    if (link && link.includes('.zip')) {
                        downloadPath = link;
                        return false;
                    }
                }
            });
        }

        if (downloadPath) {
            // Ensure full URL
            if (downloadPath.startsWith('/')) downloadPath = `https://yifysubtitles.ch${downloadPath}`;

            // Note: This is a ZIP file. We ideally need to unzip it.
            // For now, returning the ZIP URL might not be enough for the player to handle directly 
            // without backend processing (unzip -> vtt).
            // BUT, the plan was "Best Effort". 
            // To make it truly "One Click", we need to unzip it.

            return {
                lang: 'en',
                url: downloadPath,
                isZip: true
            };
        }

        return null;

    } catch (error) {
        console.error("Scraper Error:", error.message);
        return null;
    }
}

module.exports = { searchSubtitles };
