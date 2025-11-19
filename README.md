# Spotify Podcast Transcriber

Extract and transcribe Spotify podcast episodes using Groq's Whisper API with automatic chunking, real-time progress tracking, and a modern UI.

## ✨ Features

- **Automatic RSS Feed Discovery** - Just paste the Spotify URL, we'll find the RSS feed
- **Smart Audio Chunking** - Automatically handles files larger than 25MB
- **Real-Time Progress Tracking** - See exactly what's happening at each step
- **High-Quality Transcription** - Using Groq's Whisper large-v3 model
- **Modern, Sleek UI** - Clean blue/cyan design with smooth animations
- **Fast Processing** - Typically 1-3 minutes per episode
- **One-Click Deployment** - Easy deployment to Render
- **Free to Use** - Powered by free APIs (Groq, Apple iTunes)

## 🚀 Quick Start

### Prerequisites

- Node.js (v18 or higher)
- ffmpeg (for audio processing)
  - Mac: `brew install ffmpeg`
  - Ubuntu: `sudo apt install ffmpeg`
  - Windows: Download from [ffmpeg.org](https://ffmpeg.org/download.html)
- A free Groq API key ([Get one here](https://console.groq.com/keys))

### Installation

1. **Clone or download this repository**

2. **Install dependencies:**
```bash
npm install
```

3. **Create environment file:**
```bash
cp .env.example .env
```

4. **Add your Groq API key to `.env`:**
```env
GROQ_API_KEY=your_actual_groq_api_key_here
```

### Running Locally

```bash
npm start
```

Then open [http://localhost:3000](http://localhost:3000) in your browser.

For development with auto-reload:
```bash
npm run dev
```

## 📖 Usage

1. **Paste a Spotify podcast episode URL**
   ```
   https://open.spotify.com/episode/2H3Bazrpl5otl7eGb545Yi
   ```

2. **Leave RSS feed empty** (automatic discovery) or provide manually

3. **Click "Get Transcript"**

4. **Watch real-time progress** through 7 steps:
   - ✓ Extracting Metadata
   - ✓ Finding RSS Feed
   - ✓ Parsing Feed
   - ✓ Downloading Audio
   - ✓ Processing Audio (compress/chunk if needed)
   - ✓ Transcribing
   - ✓ Complete!

5. **Copy or read your transcript**

## 🌐 Deploy to Render (Free)

### Option 1: One-Click Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

### Option 2: Manual Deploy

1. **Push code to GitHub**

2. **Go to [Render Dashboard](https://dashboard.render.com/)**

3. **Click "New +" → "Blueprint"**

4. **Connect your GitHub repository**

5. **Render will detect `render.yaml` and deploy automatically**

6. **Add environment variables:**
   - `GROQ_API_KEY` - Your Groq API key (required)
   - `PODCAST_INDEX_KEY` - Optional, for better RSS discovery
   - `PODCAST_INDEX_SECRET` - Optional, for better RSS discovery

7. **Wait 2-3 minutes for deployment**

8. **Access your app at** `https://your-app-name.onrender.com`

### Render Configuration

The `render.yaml` file configures:
- **Free tier** web service
- **Auto-deploy** on push to main branch
- **Health checks** at `/api/health`
- **Environment variables** setup
- **Singapore region** (change in `render.yaml` if needed)

## 🎯 How It Works

### Automatic RSS Feed Discovery

1. **Apple iTunes API** (free, no setup) - Searches iTunes database
2. **Podcast Index API** (optional) - Enhanced search accuracy

### Smart Audio Processing

- **Files < 25MB**: Compress and transcribe directly
- **Files > 25MB**:
  - Split into 600-second (10-minute) chunks
  - 10-second overlap to prevent word cutoff
  - Transcribe each chunk in parallel
  - Intelligently merge transcriptions

### Real-Time Progress

- Server-Sent Events (SSE) for live updates
- Step-by-step progress indicators
- Percentage completion for each step
- Automatic error handling and recovery

## 🔧 Configuration

### Environment Variables

```env
# Required
GROQ_API_KEY=your_groq_api_key

# Optional - Enhanced RSS Discovery
PODCAST_INDEX_KEY=your_podcast_index_key
PODCAST_INDEX_SECRET=your_podcast_index_secret

# Optional - Server Configuration
PORT=3000
NODE_ENV=production
```

### Get API Keys

- **Groq API**: Free, sign up at [console.groq.com](https://console.groq.com/keys)
- **Podcast Index**: Free, sign up at [podcastindex.org](https://api.podcastindex.org/signup)

## 📡 API Endpoints

### `POST /api/transcript`

Start transcription job.

**Request:**
```json
{
  "spotifyUrl": "https://open.spotify.com/episode/...",
  "rssUrl": "optional_rss_feed_url"
}
```

**Response:**
```json
{
  "jobId": "abc123...",
  "message": "Transcription started"
}
```

### `GET /api/progress/:jobId`

Real-time progress updates via Server-Sent Events (SSE).

### `GET /api/result/:jobId`

Get final transcription result.

**Response:**
```json
{
  "success": true,
  "episode": {
    "title": "Episode Title",
    "published": "2024-01-15T10:00:00Z",
    "duration": "45:30"
  },
  "transcript": "Full transcript text..."
}
```

### `GET /api/health`

Health check endpoint.

## 🎨 UI Features

- **Modern Design** - Clean blue/cyan gradient
- **Responsive** - Works on desktop, tablet, and mobile
- **Smooth Animations** - Professional transitions and loading states
- **Progress Tracking** - Visual indicators for each step
- **Error Handling** - Clear error messages and recovery
- **Copy to Clipboard** - One-click transcript copying

## 🛠️ Technical Stack

- **Backend**: Node.js, Express.js
- **Frontend**: Vanilla JavaScript, HTML5, CSS3
- **Transcription**: Groq Whisper API (large-v3 model)
- **Audio Processing**: ffmpeg, fluent-ffmpeg
- **RSS Discovery**: Apple iTunes API, Podcast Index API
- **Real-Time Updates**: Server-Sent Events (SSE)
- **Deployment**: Render (with render.yaml blueprint)

## 📊 Limits & Performance

### Groq API Limits (Free Tier)

- **File Size**: 25 MB max (automatically chunked if larger)
- **Rate Limits**: 20 requests/minute, 7,200 audio seconds/hour
- **Transcription Speed**: ~299x real-time (very fast!)

### Audio Chunking

- **Chunk Size**: 600 seconds (10 minutes)
- **Overlap**: 10 seconds (prevents word cutoff)
- **Processing**: Sequential with rate limit respect
- **Merging**: Smart overlap removal

## 🚨 Limitations

**Won't work for:**
- Spotify-exclusive podcasts (no RSS feed exists)
- Podcasts not on Apple iTunes or Podcast Index
- Very obscure podcasts with unusual names

**In these cases:**
- You'll get a helpful error message
- You can manually find and paste the RSS feed URL

## 🐛 Troubleshooting

### "Could not find RSS feed"

**Solutions:**
1. Manually find the RSS feed on Apple Podcasts
2. Sign up for free Podcast Index API keys
3. Check if podcast is Spotify-exclusive

### "Request Entity Too Large"

**This shouldn't happen** - the app automatically chunks large files.

If you see this error:
1. Check `MAX_FILE_SIZE_MB` in `server.js`
2. Ensure ffmpeg is installed correctly
3. Check server logs for chunking errors

### Server errors during transcription

**Check:**
1. Groq API key is valid
2. You haven't exceeded rate limits
3. ffmpeg is installed and in PATH
4. Sufficient disk space for temp files

## 📝 Development

### Project Structure

```
Spotify Summariser/
├── server.js              # Express server with chunking & progress
├── package.json           # Dependencies and scripts
├── render.yaml            # Render deployment config
├── .env                   # Environment variables (not in git)
├── .env.example           # Template for environment variables
├── .gitignore             # Git ignore rules
├── README.md              # This file
├── public/
│   ├── index.html         # Modern UI structure
│   ├── styles.css         # Blue/cyan theme styling
│   └── app.js             # SSE-based progress tracking
└── temp/                  # Auto-created for audio processing
```

### Adding Features

1. **Backend**: Modify `server.js`
2. **Frontend**: Update `public/` files
3. **Deployment**: Configure `render.yaml`
4. **Environment**: Update `.env.example`

## 🤝 Contributing

Feel free to open issues or submit pull requests for improvements!

## 📄 License

MIT

## 🙏 Credits

- **Transcription**: [Groq](https://groq.com) Whisper API
- **RSS Discovery**: Apple iTunes API, [Podcast Index](https://podcastindex.org)
- **Audio Processing**: [FFmpeg](https://ffmpeg.org)
- **Font**: [Inter](https://rsms.me/inter/) by Rasmus Andersson

## 💡 Tips

- **Longer podcasts**: May take 3-5 minutes due to chunking
- **Best results**: Podcasts with clear audio and single speakers
- **Rate limits**: If transcribing many episodes, spread them out
- **Caching**: Consider adding Redis for production use
- **Scaling**: Use worker processes for concurrent transcriptions

---

**Made with ❤️ for podcast lovers**
