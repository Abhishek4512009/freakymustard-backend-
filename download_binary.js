const fs = require('fs');
const path = require('path');
const axios = require('axios');

const download = async () => {
    const binaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    const binaryPath = path.join(__dirname, binaryName);
    const url = process.platform === 'win32' 
        ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' 
        : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

    console.log(`Checking for ${binaryName} at ${binaryPath}...`);

    if (fs.existsSync(binaryPath)) {
        console.log('✅ yt-dlp binary already exists.');
        return;
    }

    console.log(`⬇️ Downloading yt-dlp from configured URL...`);
    
    try {
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream'
        });

        const writer = fs.createWriteStream(binaryPath);

        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                console.log('✅ yt-dlp downloaded successfully!');
                if (process.platform !== 'win32') {
                    fs.chmodSync(binaryPath, '777');
                    console.log('🔐 Permissions set to 777');
                }
                resolve();
            });
            writer.on('error', reject);
        });
    } catch (err) {
        console.error('❌ Failed to download yt-dlp:', err.message);
        // Don't exit with error to avoid breaking average build if it fails? 
        // No, we need it. Exit 1.
        process.exit(1);
    }
};

download();