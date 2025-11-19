const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const Parser = require('rss-parser');
const Groq = require('groq-sdk');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join(__dirname, 'temp');
const MAX_FILE_SIZE_MB = 25; // Groq free tier limit
const CHUNK_DURATION_SECONDS = 600; // 10 minutes
const CHUNK_OVERLAP_SECONDS = 10;

// Progress tracking
const progressStore = new Map();

// Initialize spotify-url-info with axios-based fetch
const spotifyUrlInfo = require('spotify-url-info')(async (url) => {
  const response = await axios.get(url);
  return {
    text: async () => response.data
  };
});

// Initialize services
const rssParser = new Parser();
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL_ID = process.env.GEMINI_MODEL_ID || 'gemini-flash-latest';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Progress helper
const updateProgress = (jobId, step, percentage, message) => {
  const progress = progressStore.get(jobId) || {};
  progress[step] = { percentage, message, timestamp: Date.now() };
  progressStore.set(jobId, progress);
  console.log(`[${jobId}] ${step}: ${message} (${percentage}%)`);
};

// Podcast Index API helper
const searchPodcastIndex = async (podcastName) => {
  try {
    const apiKey = process.env.PODCAST_INDEX_KEY;
    const apiSecret = process.env.PODCAST_INDEX_SECRET;

    if (!apiKey || !apiSecret) {
      console.log('Podcast Index API keys not configured, skipping...');
      return [];
    }

    const apiHeaderTime = Math.floor(Date.now() / 1000);
    const hash = crypto.createHash('sha1').update(apiKey + apiSecret + apiHeaderTime).digest('hex');

    const response = await axios.get('https://api.podcastindex.org/api/1.0/search/byterm', {
      params: { q: podcastName },
      headers: {
        'X-Auth-Date': apiHeaderTime.toString(),
        'X-Auth-Key': apiKey,
        'Authorization': hash,
        'User-Agent': 'SpotifyTranscriber/1.0'
      }
    });

    return response.data.feeds || [];
  } catch (error) {
    console.error('Podcast Index search error:', error.message);
    return [];
  }
};

// Fallback: Search Apple Podcasts and extract RSS feed
const searchApplePodcasts = async (podcastName) => {
  try {
    console.log('Searching Apple Podcasts for:', podcastName);

    const searchResponse = await axios.get('https://itunes.apple.com/search', {
      params: {
        term: podcastName,
        media: 'podcast',
        entity: 'podcast',
        limit: 5
      }
    });

    const results = searchResponse.data.results;
    if (!results || results.length === 0) {
      return null;
    }

    const podcast = results[0];
    if (podcast.feedUrl) {
      console.log('Found RSS feed via iTunes API:', podcast.feedUrl);
      return podcast.feedUrl;
    }

    return null;
  } catch (error) {
    console.error('Apple Podcasts search error:', error.message);
    return null;
  }
};

// Find RSS feed with multiple fallback methods
const findRssFeed = async (podcastName) => {
  console.log('Attempting to find RSS feed for:', podcastName);

  const podcastIndexResults = await searchPodcastIndex(podcastName);
  if (podcastIndexResults && podcastIndexResults.length > 0) {
    console.log('Found via Podcast Index API');
    return podcastIndexResults[0].url;
  }

  const applePodcastsFeed = await searchApplePodcasts(podcastName);
  if (applePodcastsFeed) {
    return applePodcastsFeed;
  }

  return null;
};

// Ensure temp directory exists
const initTempDir = async () => {
  try {
    await fs.mkdir(TEMP_DIR, { recursive: true });
  } catch (error) {
    console.error('Error creating temp directory:', error);
  }
};

// Extract Spotify episode ID from URL
const extractEpisodeId = (url) => {
  const match = url.match(/episode\/([a-zA-Z0-9]+)/);
  if (!match) {
    throw new Error('Invalid Spotify episode URL');
  }
  return match[1];
};

// Download audio file to temp directory
const downloadAudio = async (audioUrl, episodeId, jobId) => {
  const filename = `${episodeId}_${Date.now()}.mp3`;
  const filepath = path.join(TEMP_DIR, filename);

  updateProgress(jobId, 'download', 0, 'Starting download...');
  console.log('Downloading audio from:', audioUrl);

  const response = await axios({
    method: 'GET',
    url: audioUrl,
    responseType: 'stream',
    onDownloadProgress: (progressEvent) => {
      if (progressEvent.total) {
        const percentage = Math.round((progressEvent.loaded * 100) / progressEvent.total);
        updateProgress(jobId, 'download', percentage, `Downloading audio... ${percentage}%`);
      }
    }
  });

  const writer = require('fs').createWriteStream(filepath);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', () => {
      updateProgress(jobId, 'download', 100, 'Download complete');
      resolve(filepath);
    });
    writer.on('error', reject);
  });
};

// Get file size in MB
const getFileSizeMB = async (filepath) => {
  const stats = await fs.stat(filepath);
  return stats.size / (1024 * 1024);
};

// Get audio duration using ffmpeg
const getAudioDuration = (filepath) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filepath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration);
    });
  });
};

// Split audio into chunks using ffmpeg
const splitAudioIntoChunks = async (inputPath, jobId) => {
  const duration = await getAudioDuration(inputPath);
  const chunks = [];
  const numChunks = Math.ceil(duration / CHUNK_DURATION_SECONDS);

  updateProgress(jobId, 'splitting', 0, `Splitting into ${numChunks} chunks...`);

  for (let i = 0; i < numChunks; i++) {
    const startTime = Math.max(0, i * CHUNK_DURATION_SECONDS - CHUNK_OVERLAP_SECONDS);
    const chunkPath = inputPath.replace('.mp3', `_chunk_${i}.mp3`);

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .setStartTime(startTime)
        .setDuration(CHUNK_DURATION_SECONDS + CHUNK_OVERLAP_SECONDS)
        .output(chunkPath)
        .audioCodec('libmp3lame')
        .audioChannels(1)
        .audioFrequency(16000)
        .audioBitrate('64k')
        .on('end', () => {
          console.log(`Chunk ${i + 1}/${numChunks} created`);
          chunks.push(chunkPath);
          const percentage = Math.round(((i + 1) / numChunks) * 100);
          updateProgress(jobId, 'splitting', percentage, `Created chunk ${i + 1}/${numChunks}`);
          resolve();
        })
        .on('error', reject)
        .run();
    });
  }

  updateProgress(jobId, 'splitting', 100, 'Audio splitting complete');
  return chunks;
};

// Clean up temporary file
const cleanupFile = async (filepath) => {
  try {
    await fs.unlink(filepath);
    console.log('Cleaned up temp file:', filepath);
  } catch (error) {
    console.error('Error cleaning up file:', error);
  }
};

// Summarise transcript with Gemini
const summariseWithGemini = async (transcript, episodeTitle, jobId) => {
  if (!GEMINI_API_KEY) {
    console.warn('GEMINI_API_KEY is not set. Skipping Gemini summarisation.');
    if (jobId) {
      updateProgress(jobId, 'summary', 100, 'Summary skipped (Gemini API key not configured)');
    }
    return null;
  }

  try {
    updateProgress(jobId, 'summary', 0, 'Summarising transcript with Gemini...');

    const prompt = [
      'You are an assistant that writes short, punchy summaries of podcast transcripts.',
      '',
      episodeTitle ? `Episode title: ${episodeTitle}` : '',
      '',
      'Task:',
      '- Summarise the episode clearly and engagingly for a busy listener.',
      '- Use markdown formatting with the following sections, in this order:',
      '  - ### TL;DR (2–5 bullet points, each starting with "- ")',
      '  - ### Key Topics',
      '  - ### Notable Quotes (if any, paraphrased if needed)',
      '  - ### Actionable Takeaways',
      '- Do NOT include a separate H1/H2 title; start directly with the TL;DR section.',
      '- Keep the entire response under about 300 words.',
      '',
      'Transcript:',
      transcript.length > 20000 ? transcript.slice(0, 20000) + '\n\n[Truncated transcript]' : transcript
    ].join('\n');

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_ID}:generateContent`,
      {
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: prompt
              }
            ]
          }
        ]
      },
      {
        params: {
          key: GEMINI_API_KEY
        }
      }
    );

    const candidates = response.data && response.data.candidates;
    const summaryText = candidates && candidates[0] && candidates[0].content && candidates[0].content.parts
      ? candidates[0].content.parts.map((p) => p.text || '').join('')
      : null;

    if (!summaryText) {
      updateProgress(jobId, 'summary', 100, 'Summary skipped (no response from Gemini)');
      return null;
    }

    updateProgress(jobId, 'summary', 100, 'Summary ready');
    return summaryText.trim();
  } catch (error) {
    console.error('Gemini summarisation error:', error.response?.data || error.message || error);
    updateProgress(jobId, 'summary', 100, 'Could not generate summary (Gemini error)');
    return null;
  }
};

// Compress audio file to reduce size
const compressAudio = async (inputPath, jobId) => {
  const { exec } = require('child_process');
  const util = require('util');
  const execPromise = util.promisify(exec);

  const outputPath = inputPath.replace('.mp3', '_compressed.mp3');

  updateProgress(jobId, 'compress', 0, 'Compressing audio...');
  console.log('Compressing audio file...');

  const command = `ffmpeg -i "${inputPath}" -ac 1 -ar 16000 -b:a 64k -y "${outputPath}"`;

  try {
    await execPromise(command);
    updateProgress(jobId, 'compress', 100, 'Compression complete');
    console.log('Audio compressed successfully');
    return outputPath;
  } catch (error) {
    console.error('Compression error:', error.message);
    return inputPath;
  }
};

// Transcribe single file using Groq Whisper API
const transcribeWithGroq = async (filepath, chunkIndex = null, totalChunks = null, jobId) => {
  const chunkInfo = chunkIndex !== null ? ` (chunk ${chunkIndex + 1}/${totalChunks})` : '';
  updateProgress(jobId, 'transcribe', 0, `Transcribing${chunkInfo}...`);
  console.log(`Transcribing with Groq Whisper${chunkInfo}...`);

  const fileStream = require('fs').createReadStream(filepath);

  const transcription = await groq.audio.transcriptions.create({
    file: fileStream,
    model: 'whisper-large-v3',
    response_format: 'verbose_json',
    language: 'en'
  });

  if (chunkIndex !== null) {
    const percentage = Math.round(((chunkIndex + 1) / totalChunks) * 100);
    updateProgress(jobId, 'transcribe', percentage, `Transcribed chunk ${chunkIndex + 1}/${totalChunks}`);
  } else {
    updateProgress(jobId, 'transcribe', 100, 'Transcription complete');
  }

  return transcription;
};

// Merge transcriptions with overlap handling
const mergeTranscriptions = (transcriptions) => {
  if (transcriptions.length === 1) {
    return transcriptions[0].text;
  }

  let mergedText = '';
  const overlapWords = Math.ceil(CHUNK_OVERLAP_SECONDS * 2); // Approximate words in overlap

  for (let i = 0; i < transcriptions.length; i++) {
    const text = transcriptions[i].text;

    if (i === 0) {
      // First chunk: use all text
      mergedText = text;
    } else {
      // Remove overlap from start of current chunk
      const words = text.split(' ');
      const textWithoutOverlap = words.slice(overlapWords).join(' ');
      mergedText += ' ' + textWithoutOverlap;
    }
  }

  return mergedText.trim();
};

// Main transcription logic with chunking support
const processTranscription = async (audioPath, jobId) => {
  const fileSizeMB = await getFileSizeMB(audioPath);
  console.log(`Audio file size: ${fileSizeMB.toFixed(2)} MB`);

  // Check if file needs to be chunked
  if (fileSizeMB > MAX_FILE_SIZE_MB) {
    console.log(`File exceeds ${MAX_FILE_SIZE_MB}MB limit, splitting into chunks...`);

    // Split into chunks
    const chunks = await splitAudioIntoChunks(audioPath, jobId);

    // Transcribe each chunk
    const transcriptions = [];
    for (let i = 0; i < chunks.length; i++) {
      const transcription = await transcribeWithGroq(chunks[i], i, chunks.length, jobId);
      transcriptions.push(transcription);

      // Clean up chunk file
      await cleanupFile(chunks[i]);
    }

    // Merge transcriptions
    updateProgress(jobId, 'merge', 0, 'Merging transcriptions...');
    const mergedText = mergeTranscriptions(transcriptions);
    updateProgress(jobId, 'merge', 100, 'Merge complete');

    return mergedText;
  } else {
    // File is small enough, compress and transcribe directly
    const compressedPath = await compressAudio(audioPath, jobId);
    const finalSizeMB = await getFileSizeMB(compressedPath);

    if (finalSizeMB > MAX_FILE_SIZE_MB) {
      // Even after compression, still too large - chunk it
      const chunks = await splitAudioIntoChunks(compressedPath, jobId);
      const transcriptions = [];

      for (let i = 0; i < chunks.length; i++) {
        const transcription = await transcribeWithGroq(chunks[i], i, chunks.length, jobId);
        transcriptions.push(transcription);
        await cleanupFile(chunks[i]);
      }

      updateProgress(jobId, 'merge', 0, 'Merging transcriptions...');
      const mergedText = mergeTranscriptions(transcriptions);
      updateProgress(jobId, 'merge', 100, 'Merge complete');

      if (compressedPath !== audioPath) {
        await cleanupFile(compressedPath);
      }

      return mergedText;
    }

    // Transcribe single file
    const transcription = await transcribeWithGroq(compressedPath, null, null, jobId);

    if (compressedPath !== audioPath) {
      await cleanupFile(compressedPath);
    }

    return transcription.text;
  }
};

// SSE endpoint for progress updates
app.get('/api/progress/:jobId', (req, res) => {
  const { jobId } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Send initial connection
  res.write('data: {"status": "connected"}\n\n');

  // Send progress updates every second
  const interval = setInterval(() => {
    const progress = progressStore.get(jobId);
    if (progress) {
      res.write(`data: ${JSON.stringify(progress)}\n\n`);

      // Check if completed
      if (progress.complete) {
        clearInterval(interval);
        res.end();
      }
    }
  }, 500);

  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(interval);
    res.end();
  });
});

// Main endpoint to get transcript
app.post('/api/transcript', async (req, res) => {
  const jobId = crypto.randomBytes(16).toString('hex');
  let tempFilePath = null;

  try {
    const { spotifyUrl, rssUrl: providedRssUrl } = req.body;

    if (!spotifyUrl) {
      return res.status(400).json({ error: 'Spotify URL is required' });
    }

    // Send immediate response with jobId
    res.json({ jobId, message: 'Transcription started. Use /api/progress/:jobId to track progress.' });

    console.log(`[${jobId}] Processing URL:`, spotifyUrl);

    // Step 1: Extract episode metadata from Spotify
    updateProgress(jobId, 'metadata', 0, 'Fetching Spotify metadata...');
    const spotifyData = await spotifyUrlInfo.getData(spotifyUrl);

    if (!spotifyData) {
      updateProgress(jobId, 'error', 100, 'Could not fetch episode data from Spotify');
      progressStore.get(jobId).complete = true;
      return;
    }

    updateProgress(jobId, 'metadata', 100, 'Metadata fetched');
    console.log(`[${jobId}] Episode found:`, spotifyData.name);

    let rssUrl = providedRssUrl;

    // Step 2: Find RSS feed
    if (!rssUrl) {
      updateProgress(jobId, 'rss', 0, 'Finding RSS feed...');
      rssUrl = await findRssFeed(spotifyData.subtitle);

      if (!rssUrl) {
        updateProgress(jobId, 'error', 100, 'Could not find RSS feed');
        progressStore.get(jobId).complete = true;
        return;
      }
      updateProgress(jobId, 'rss', 100, 'RSS feed found');
    } else {
      updateProgress(jobId, 'rss', 100, 'Using provided RSS feed');
    }

    // Step 3: Parse RSS feed
    updateProgress(jobId, 'parse', 0, 'Parsing RSS feed...');
    const feed = await rssParser.parseURL(rssUrl);

    const episodeName = spotifyData.name;
    const episode = feed.items.find(item =>
      item.title.toLowerCase().includes(episodeName.toLowerCase()) ||
      episodeName.toLowerCase().includes(item.title.toLowerCase())
    );

    const targetEpisode = episode || feed.items[0];
    const audioUrl = targetEpisode.enclosure?.url;

    if (!audioUrl) {
      updateProgress(jobId, 'error', 100, 'No audio URL found for this episode');
      progressStore.get(jobId).complete = true;
      return;
    }

    updateProgress(jobId, 'parse', 100, 'RSS parsed successfully');

    // Step 4: Download audio
    const episodeId = extractEpisodeId(spotifyUrl);
    tempFilePath = await downloadAudio(audioUrl, episodeId, jobId);

    // Step 5: Process transcription (with chunking if needed)
    const transcript = await processTranscription(tempFilePath, jobId);

    // Step 6: Summarise transcript with Gemini (if configured)
    let summary = null;
    try {
      summary = await summariseWithGemini(transcript, targetEpisode.title, jobId);
    } catch (summaryError) {
      console.error(`[${jobId}] Failed to generate summary:`, summaryError);
    }

    // Step 7: Clean up
    await cleanupFile(tempFilePath);
    tempFilePath = null;

    // Step 8: Store result
    const result = {
      success: true,
      episode: {
        title: targetEpisode.title,
        published: targetEpisode.pubDate,
        duration: targetEpisode.itunes?.duration
      },
      transcript: transcript,
      summary: summary
    };

    updateProgress(jobId, 'complete', 100, 'Transcription complete!');
    progressStore.get(jobId).result = result;
    progressStore.get(jobId).complete = true;

  } catch (error) {
    console.error(`[${jobId}] Error:`, error);

    if (tempFilePath) {
      await cleanupFile(tempFilePath);
    }

    updateProgress(jobId, 'error', 100, error.message || 'An error occurred');
    progressStore.get(jobId).complete = true;
  }
});

// Get final result
app.get('/api/result/:jobId', (req, res) => {
  const { jobId } = req.params;
  const progress = progressStore.get(jobId);

  if (!progress) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (progress.result) {
    // Clean up after sending result
    setTimeout(() => progressStore.delete(jobId), 60000); // Clean up after 1 minute
    return res.json(progress.result);
  }

  if (progress.error) {
    return res.status(500).json({ error: progress.error.message });
  }

  res.status(202).json({ message: 'Transcription still in progress' });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Spotify Podcast Transcriber is running' });
});

// Start server
const startServer = async () => {
  await initTempDir();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Make sure to set GROQ_API_KEY in .env file`);
  });
};

startServer();
