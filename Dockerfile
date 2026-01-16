FROM node:18-slim

# Install Python 3 and FFmpeg required for yt-dlp
RUN apt-get update && \
    apt-get install -y python3 python3-pip ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy app source
COPY . .

# Start the server
CMD ["node", "server.js"]
