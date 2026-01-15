const YTDlpWrap = require('yt-dlp-wrap').default;
const fs = require('fs');
const path = require('path');

const download = async () => {
    const binaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    const binaryPath = path.join(__dirname, binaryName);

    console.log(`Checking for ${binaryName} at ${binaryPath}...`);

    if (fs.existsSync(binaryPath)) {
        console.log('✅ yt-dlp binary already exists.');
        return;
    }

    console.log('⬇️ Downloading yt-dlp binary...');
    try {
        await YTDlpWrap.downloadFromGithub(binaryPath);
        console.log('✅ yt-dlp downloaded successfully!');

        if (process.platform !== 'win32') {
            fs.chmodSync(binaryPath, '777'); // Ensure executable
            console.log('🔐 Permissions set to 777');
        }
    } catch (err) {
        console.error('❌ Failed to download yt-dlp:', err);
        process.exit(1);
    }
};

download();