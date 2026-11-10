const http = require('http');
const { io: ioClient } = require('socket.io-client');

async function testBackend() {
  console.log('--- Starting Backend Verification Tests ---');

  // 1. Health check HTTP request
  await new Promise((resolve, reject) => {
    http.get('http://localhost:5000/api/health', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          console.log('[PASS] /api/health returned:', json);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });

  // 2. Connect Socket 1 (Creator)
  const socket1 = ioClient('http://localhost:5000');
  await new Promise((resolve) => socket1.on('connect', resolve));
  console.log('[PASS] Socket 1 connected:', socket1.id);

  // 3. Create room
  let roomCode = null;
  await new Promise((resolve, reject) => {
    socket1.emit('create_room', (res) => {
      if (res && res.success) {
        roomCode = res.room.roomCode;
        console.log('[PASS] Room created successfully. Code:', roomCode);
        resolve();
      } else {
        reject(new Error('Failed to create room'));
      }
    });
  });

  // 4. Connect Socket 2 (Partner)
  const socket2 = ioClient('http://localhost:5000');
  await new Promise((resolve) => socket2.on('connect', resolve));
  console.log('[PASS] Socket 2 connected:', socket2.id);

  // Partner joins room
  await new Promise((resolve, reject) => {
    // Socket 1 should receive partner_joined event
    socket1.once('partner_joined', (data) => {
      console.log('[PASS] Socket 1 received partner_joined event:', data.participantCount);
    });

    socket2.emit('join_room', { roomCode }, (res) => {
      if (res && res.success) {
        console.log('[PASS] Socket 2 joined room successfully. Participants:', res.room.participantCount);
        resolve();
      } else {
        reject(new Error('Socket 2 failed to join room: ' + res?.message));
      }
    });
  });

  // 5. Connect Socket 3 (Should be rejected because room limit is 2)
  const socket3 = ioClient('http://localhost:5000');
  await new Promise((resolve) => socket3.on('connect', resolve));
  await new Promise((resolve) => {
    socket3.emit('join_room', { roomCode }, (res) => {
      if (res && !res.success) {
        console.log('[PASS] Socket 3 correctly rejected (room full):', res.message);
        socket3.disconnect();
        resolve();
      } else {
        console.error('[FAIL] Socket 3 was not rejected!');
        process.exit(1);
      }
    });
  });

  // 6. Test select song synchronization
  const testSong = {
    roomCode,
    videoId: 'dQw4w9WgXcQ',
    title: 'Never Gonna Give You Up',
    thumbnail: 'https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    channel: 'Rick Astley',
  };

  await new Promise((resolve) => {
    socket2.once('song_selected', (data) => {
      console.log('[PASS] Socket 2 received song_selected:', data.title, data.videoId);
      if (data.videoId === testSong.videoId) {
        resolve();
      }
    });
    socket1.emit('select_song', testSong);
  });

  // 7. Test play synchronization
  await new Promise((resolve) => {
    socket2.once('partner_play', (data) => {
      console.log('[PASS] Socket 2 received partner_play at:', data.currentTime);
      resolve();
    });
    socket1.emit('play_song', { roomCode, currentTime: 15.5 });
  });

  // 8. Test pause synchronization
  await new Promise((resolve) => {
    socket1.once('partner_pause', (data) => {
      console.log('[PASS] Socket 1 received partner_pause at:', data.currentTime);
      resolve();
    });
    socket2.emit('pause_song', { roomCode, currentTime: 22.0 });
  });

  // 9. Test seek synchronization
  await new Promise((resolve) => {
    socket2.once('partner_seek', (data) => {
      console.log('[PASS] Socket 2 received partner_seek at:', data.currentTime);
      resolve();
    });
    socket1.emit('seek_song', { roomCode, currentTime: 45.2 });
  });

  // 10. Test room status endpoint via HTTP
  await new Promise((resolve, reject) => {
    http.get(`http://localhost:5000/api/rooms/${roomCode}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          console.log('[PASS] /api/rooms/:code returned:', json);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });

  // 11. Test search endpoint with direct URL
  await new Promise((resolve, reject) => {
    http.get(`http://localhost:5000/api/search?q=https://www.youtube.com/watch?v=dQw4w9WgXcQ`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          console.log('[PASS] /api/search direct URL returned:', json.results?.[0]?.id);
          if (json.results?.[0]?.id === 'dQw4w9WgXcQ') {
            resolve();
          } else {
            reject(new Error('Search failed'));
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });

  // 12. Test disconnect of partner
  await new Promise((resolve) => {
    socket1.once('partner_left', (data) => {
      console.log('[PASS] Socket 1 received partner_left notification. Remaining:', data.participantCount);
      resolve();
    });
    socket2.disconnect();
  });

  socket1.disconnect();
  console.log('--- ALL BACKEND & SYNC PROTOCOL TESTS PASSED! ---');
  process.exit(0);
}

// Start backend server first, then run tests
const serverProcess = require('child_process').fork('backend/server.js');
setTimeout(() => {
  testBackend().catch((err) => {
    console.error('Test failed with error:', err);
    serverProcess.kill();
    process.exit(1);
  }).finally(() => {
    serverProcess.kill();
  });
}, 1500);
