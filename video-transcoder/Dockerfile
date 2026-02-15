# 1. Use Node 18 on Alpine Linux (lightweight)
FROM node:18-alpine

# 2. Set the working directory inside the container
WORKDIR /app

# 3. Install FFmpeg (Crucial for video processing)
RUN apk add --no-cache ffmpeg

# 4. Copy package.json and install dependencies
COPY package*.json ./
RUN npm install

# 5. Copy the rest of the backend code
COPY . .

# 6. Expose the port (Render will override this, but good practice)
EXPOSE 3000

# 7. Start the server
CMD ["node", "server.js"]