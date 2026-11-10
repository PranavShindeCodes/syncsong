require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 5000;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';

// Enable CORS for Express and Socket.IO
app.use(cors({
  origin: '*', // Allow all origins for seamless mobile/local network access
  methods: ['GET', 'POST'],
}));
app.use(express.json());

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  pingInterval: 10000,
  pingTimeout: 5000,
});

// In-memory store for rooms
// Key: roomCode -> { roomCode, participants: [{ id, joinedAt }], currentVideoId, currentSongTitle, currentSongThumbnail, currentSongChannel, currentTime, isPlaying, updatedAt }
const rooms = new Map();

// Helper: Generate random 6-character room code (alphanumeric, avoiding confusing characters)
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Helper: Calculate current synchronized playback time
function calculateRoomTime(room) {
  if (!room.isPlaying) {
    return room.currentTime || 0;
  }
  const elapsed = (Date.now() - (room.updatedAt || Date.now())) / 1000;
  return Math.max(0, (room.currentTime || 0) + elapsed);
}

// Helper: Format room state for client consumption
function getRoomClientState(room) {
  return {
    roomCode: room.roomCode,
    participantCount: room.participants.length,
    currentVideoId: room.currentVideoId,
    currentSongTitle: room.currentSongTitle,
    currentSongThumbnail: room.currentSongThumbnail,
    currentSongChannel: room.currentSongChannel,
    currentTime: calculateRoomTime(room),
    isPlaying: room.isPlaying,
    updatedAt: room.updatedAt,
    serverTime: Date.now(),
  };
}

// ---------------- REST API ENDPOINTS ----------------

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    activeRooms: rooms.size,
    hasApiKey: Boolean(YOUTUBE_API_KEY),
  });
});

// Inspect room details
app.get('/api/rooms/:code', (req, res) => {
  const code = (req.params.code || '').trim().toUpperCase();
  const room = rooms.get(code);
  if (!room) {
    return res.status(404).json({ exists: false, message: 'Room not found' });
  }
  return res.json({
    exists: true,
    roomCode: room.roomCode,
    participantCount: room.participants.length,
    isFull: room.participants.length >= 2,
    hasSong: Boolean(room.currentVideoId),
  });
});

// Helper: Extract YouTube video ID from URL or return if it's already an 11-char ID
function extractVideoId(input) {
  if (!input) return null;
  const trimmed = input.trim();
  // Check if it's already a standard 11-character video ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }
  // Try matching standard YouTube URL patterns
  const urlPatterns = [
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
    /(?:https?:\/\/)?(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const regex of urlPatterns) {
    const match = trimmed.match(regex);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

// YouTube Song Search
app.get('/api/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) {
    return res.status(400).json({ error: 'Search query or URL is required' });
  }

  // Check if query is a direct YouTube URL or video ID
  const directId = extractVideoId(query);
  if (directId) {
    // If API key is available, try to fetch title & channel
    if (YOUTUBE_API_KEY) {
      try {
        const videoRes = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
          params: {
            part: 'snippet',
            id: directId,
            key: YOUTUBE_API_KEY,
          },
          timeout: 8000,
        });
        const item = videoRes.data?.items?.[0];
        if (item) {
          return res.json({
            results: [{
              id: directId,
              title: item.snippet.title,
              channel: item.snippet.channelTitle,
              thumbnail:
                item.snippet.thumbnails?.medium?.url ||
                item.snippet.thumbnails?.high?.url ||
                `https://img.youtube.com/vi/${directId}/hqdefault.jpg`,
            }],
          });
        }
      } catch (err) {
        console.warn('Direct video ID lookup failed via API, falling back to basic metadata:', err.message);
      }
    }

    // Direct result fallback
    return res.json({
      results: [{
        id: directId,
        title: `YouTube Video (${directId})`,
        channel: 'YouTube',
        thumbnail: `https://img.youtube.com/vi/${directId}/hqdefault.jpg`,
      }],
    });
  }

  if (!YOUTUBE_API_KEY) {
    return res.status(400).json({
      error: 'YouTube API key is missing. Add YOUTUBE_API_KEY to backend/.env, or paste a direct YouTube link / video ID.',
    });
  }

  try {
    const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet',
        type: 'video',
        videoEmbeddable: 'true',
        maxResults: 15,
        q: query,
        key: YOUTUBE_API_KEY,
      },
      timeout: 8000,
    });

    const items = response.data?.items || [];
    const results = items
      .filter((item) => item.id && item.id.videoId)
      .map((item) => ({
        id: item.id.videoId,
        title: item.snippet.title,
        channel: item.snippet.channelTitle,
        thumbnail:
          item.snippet.thumbnails?.medium?.url ||
          item.snippet.thumbnails?.high?.url ||
          item.snippet.thumbnails?.default?.url ||
          '',
      }));

    return res.json({ results });
  } catch (error) {
    console.error('YouTube search error:', error?.response?.data || error.message);
    const apiError = error?.response?.data?.error;
    if (apiError) {
      if (apiError.errors?.some((e) => e.reason === 'quotaExceeded')) {
        return res.status(429).json({
          error: 'YouTube API daily quota exceeded. You can still paste direct YouTube links / video IDs to listen.',
        });
      }
      return res.status(error.response.status || 500).json({
        error: apiError.message || 'YouTube API error occurred.',
      });
    }
    return res.status(500).json({ error: 'Failed to search YouTube. Check server connection.' });
  }
});

// ---------------- SOCKET.IO REAL-TIME LOGIC ----------------

io.on('connection', (socket) => {
  console.log(`[Socket Connected] ID: ${socket.id}`);

  // Create room
  socket.on('create_room', (callback) => {
    try {
      let code = generateRoomCode();
      // Ensure unique code
      while (rooms.has(code)) {
        code = generateRoomCode();
      }

      const newRoom = {
        roomCode: code,
        participants: [{ id: socket.id, joinedAt: Date.now() }],
        currentVideoId: null,
        currentSongTitle: null,
        currentSongThumbnail: null,
        currentSongChannel: null,
        currentTime: 0,
        isPlaying: false,
        updatedAt: Date.now(),
      };

      rooms.set(code, newRoom);
      socket.join(code);
      socket.currentRoom = code;

      console.log(`[Room Created] Code: ${code} by Socket: ${socket.id}`);

      const state = getRoomClientState(newRoom);
      if (typeof callback === 'function') {
        callback({ success: true, room: state });
      }
      socket.emit('room_created', state);
    } catch (err) {
      console.error('create_room error:', err);
      if (typeof callback === 'function') {
        callback({ success: false, message: 'Could not create room' });
      }
    }
  });

  // Join room
  socket.on('join_room', ({ roomCode }, callback) => {
    try {
      const code = (roomCode || '').trim().toUpperCase();
      const room = rooms.get(code);

      if (!room) {
        const errorMsg = 'Room not found. Please double check the 6-character code.';
        if (typeof callback === 'function') callback({ success: false, message: errorMsg });
        socket.emit('error_message', { message: errorMsg });
        return;
      }

      // Check if participant is already inside this room
      const existingIdx = room.participants.findIndex((p) => p.id === socket.id);

      if (existingIdx === -1 && room.participants.length >= 2) {
        const errorMsg = 'Room is already full (maximum 2 participants allowed).';
        if (typeof callback === 'function') callback({ success: false, message: errorMsg });
        socket.emit('error_message', { message: errorMsg });
        return;
      }

      if (existingIdx === -1) {
        room.participants.push({ id: socket.id, joinedAt: Date.now() });
      }

      socket.join(code);
      socket.currentRoom = code;

      console.log(`[Room Joined] Code: ${code} by Socket: ${socket.id}. Total: ${room.participants.length}`);

      const state = getRoomClientState(room);

      if (typeof callback === 'function') {
        callback({ success: true, room: state });
      }

      // Notify the joiner with initial state
      socket.emit('room_joined', state);

      // Notify the partner that user joined
      socket.to(code).emit('partner_joined', {
        participantCount: room.participants.length,
        room: state,
      });
    } catch (err) {
      console.error('join_room error:', err);
      if (typeof callback === 'function') {
        callback({ success: false, message: 'Failed to join room' });
      }
    }
  });

  // Song selected
  socket.on('select_song', ({ roomCode, videoId, title, thumbnail, channel }) => {
    const code = (roomCode || socket.currentRoom || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room || !videoId) return;

    room.currentVideoId = videoId;
    room.currentSongTitle = title || 'Unknown Title';
    room.currentSongThumbnail = thumbnail || '';
    room.currentSongChannel = channel || '';
    room.currentTime = 0;
    room.isPlaying = true; // Auto-play when selecting
    room.updatedAt = Date.now();

    console.log(`[Song Selected] Room: ${code}, Song: ${title} (${videoId})`);

    const syncPayload = {
      videoId,
      title: room.currentSongTitle,
      thumbnail: room.currentSongThumbnail,
      channel: room.currentSongChannel,
      currentTime: 0,
      isPlaying: true,
      serverTime: Date.now(),
    };

    // Broadcast to EVERYONE in the room including sender so both sync identically
    io.in(code).emit('song_selected', syncPayload);
  });

  // Play event
  socket.on('play_song', ({ roomCode, currentTime }) => {
    const code = (roomCode || socket.currentRoom || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return;

    room.isPlaying = true;
    if (typeof currentTime === 'number' && !isNaN(currentTime)) {
      room.currentTime = currentTime;
    }
    room.updatedAt = Date.now();

    console.log(`[Playback Play] Room: ${code}, Time: ${room.currentTime}s`);

    // Broadcast to other participant
    socket.to(code).emit('partner_play', {
      currentTime: room.currentTime,
      serverTime: Date.now(),
    });
  });

  // Pause event
  socket.on('pause_song', ({ roomCode, currentTime }) => {
    const code = (roomCode || socket.currentRoom || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return;

    room.isPlaying = false;
    if (typeof currentTime === 'number' && !isNaN(currentTime)) {
      room.currentTime = currentTime;
    }
    room.updatedAt = Date.now();

    console.log(`[Playback Pause] Room: ${code}, Time: ${room.currentTime}s`);

    // Broadcast to other participant
    socket.to(code).emit('partner_pause', {
      currentTime: room.currentTime,
      serverTime: Date.now(),
    });
  });

  // Seek event
  socket.on('seek_song', ({ roomCode, currentTime }) => {
    const code = (roomCode || socket.currentRoom || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return;

    if (typeof currentTime === 'number' && !isNaN(currentTime)) {
      room.currentTime = currentTime;
    }
    room.updatedAt = Date.now();

    console.log(`[Playback Seek] Room: ${code}, Time: ${room.currentTime}s, isPlaying: ${room.isPlaying}`);

    // Broadcast seek to partner
    socket.to(code).emit('partner_seek', {
      currentTime: room.currentTime,
      isPlaying: room.isPlaying,
      serverTime: Date.now(),
    });
  });

  // Client sync check (periodic drift correction request or rejoin check)
  socket.on('request_sync', ({ roomCode }, callback) => {
    const code = (roomCode || socket.currentRoom || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return;

    const state = getRoomClientState(room);
    if (typeof callback === 'function') {
      callback(state);
    } else {
      socket.emit('sync_state', state);
    }
  });

  // Disconnect handling
  socket.on('disconnect', () => {
    console.log(`[Socket Disconnected] ID: ${socket.id}`);
    const code = socket.currentRoom;
    if (!code) return;

    const room = rooms.get(code);
    if (!room) return;

    room.participants = room.participants.filter((p) => p.id !== socket.id);

    console.log(`[Participant Left] Room: ${code}. Remaining: ${room.participants.length}`);

    if (room.participants.length === 0) {
      // If room is completely empty, clean it up after a 2-minute grace period (for rapid page refresh/reconnect)
      setTimeout(() => {
        const checkRoom = rooms.get(code);
        if (checkRoom && checkRoom.participants.length === 0) {
          rooms.delete(code);
          console.log(`[Room Cleaned Up] Code: ${code} deleted after inactivity.`);
        }
      }, 120000);
    } else {
      // Notify remaining partner
      socket.to(code).emit('partner_left', {
        participantCount: room.participants.length,
      });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`===============================================`);
  console.log(` OUR FOREVER Backend listening on port ${PORT}`);
  console.log(` Local:   http://localhost:${PORT}`);
  console.log(` Health:  http://localhost:${PORT}/api/health`);
  console.log(`===============================================`);
});
