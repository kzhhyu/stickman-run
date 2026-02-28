// ─────────────────────────────────────────────────────────────
//  server.js  —  Stickman Run Multiplayer Server
//
//  What this does:
//  1. Serves the index.html file to browsers
//  2. Manages WebSocket connections from players
//  3. Groups players into rooms (max 4 per room)
//  4. Relays game state between players in the same room
//  5. Tracks who is alive and announces the winner
// ─────────────────────────────────────────────────────────────

const http       = require('http');
const fs         = require('fs');
const path       = require('path');
const WebSocket  = require('ws');

const PORT = 3000;

// ── HTTP Server ───────────────────────────────────────────────
// Serves index.html when a browser visits http://localhost:3000
const httpServer = http.createServer((req, res) => {
  const filePath = path.join(__dirname, 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404); res.end('index.html not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
});

// ── WebSocket Server ──────────────────────────────────────────
// Runs on the same port as the HTTP server
const wss = new WebSocket.Server({ server: httpServer });

// ── Room Management ───────────────────────────────────────────
// rooms = { roomId: { players: Map<id, playerData> } }
const rooms = new Map();

let nextPlayerId = 1;

// Player colors — each player in a room gets a distinct color
const PLAYER_COLORS = ['#00d4ff', '#ff6b35', '#a8ff3e', '#ff3ef5'];

function findOrCreateRoom() {
  // Find a room with space (less than 4 players)
  for (const [roomId, room] of rooms) {
    if (room.players.size < 4) return roomId;
  }
  // No room with space — create a new one
  const roomId = `room_${Date.now()}`;
  rooms.set(roomId, {
    players:   new Map(),
    started:   false,
    startTimer: null,
  });
  return roomId;
}

function broadcastToRoom(roomId, message, excludeId = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  const data = JSON.stringify(message);
  room.players.forEach((player, id) => {
    if (id !== excludeId && player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(data);
    }
  });
}

function sendToPlayer(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function getRoomSnapshot(roomId) {
  // Returns a plain object snapshot of all players in a room
  const room = rooms.get(roomId);
  if (!room) return {};
  const snapshot = {};
  room.players.forEach((p, id) => {
    snapshot[id] = {
      id,
      name:    p.name,
      color:   p.color,
      x:       p.x,
      y:       p.y,
      isSliding: p.isSliding,
      onGround:  p.onGround,
      legAngle:  p.legAngle,
      alive:     p.alive,
      score:     p.score,
    };
  });
  return snapshot;
}

function checkRoomWinner(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const alivePlayers = [...room.players.values()].filter(p => p.alive);

  if (alivePlayers.length <= 1 && room.players.size > 1) {
    const winner = alivePlayers[0] || null;
    broadcastToRoom(roomId, {
      type:     'game_over',
      winnerId: winner ? winner.id : null,
      winnerName: winner ? winner.name : null,
      scores: [...room.players.values()].map(p => ({
        id: p.id, name: p.name, score: Math.floor(p.score), color: p.color
      })).sort((a, b) => b.score - a.score),
    });

    // Clean up room after 10 seconds
    setTimeout(() => {
      rooms.delete(roomId);
      console.log(`Room ${roomId} cleaned up`);
    }, 10000);
  }
}

function tryStartRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.started) return;

  // Broadcast a countdown to all players in the room
  broadcastToRoom(roomId, {
    type:        'countdown',
    players:     getRoomSnapshot(roomId),
    playerCount: room.players.size,
  });

  // Start the game after 3 seconds
  room.startTimer = setTimeout(() => {
    if (!rooms.has(roomId)) return;
    room.started = true;
    broadcastToRoom(roomId, { type: 'start', seed: Math.floor(Math.random() * 99999) });
    console.log(`Room ${roomId} started with ${room.players.size} players`);
  }, 3000);
}

// ── Connection Handler ────────────────────────────────────────
wss.on('connection', (ws) => {
  const playerId = nextPlayerId++;
  let roomId     = null;
  let playerName = `Player ${playerId}`;

  console.log(`Player ${playerId} connected`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── Player joins with a name ──
      case 'join': {
        playerName = (msg.name || playerName).slice(0, 20);
        roomId     = findOrCreateRoom();
        const room = rooms.get(roomId);

        // Assign a color based on position in room
        const colorIndex = room.players.size % PLAYER_COLORS.length;

        room.players.set(playerId, {
          id: playerId, ws,
          name:      playerName,
          color:     PLAYER_COLORS[colorIndex],
          x:         120,
          y:         240,
          isSliding: false,
          onGround:  true,
          legAngle:  0,
          alive:     true,
          score:     0,
        });

        // Tell THIS player their ID, color, and room snapshot
        sendToPlayer(ws, {
          type:     'joined',
          id:       playerId,
          color:    PLAYER_COLORS[colorIndex],
          roomId,
          players:  getRoomSnapshot(roomId),
        });

        // Tell EVERYONE ELSE a new player arrived
        broadcastToRoom(roomId, {
          type:   'player_joined',
          id:     playerId,
          name:   playerName,
          color:  PLAYER_COLORS[colorIndex],
          players: getRoomSnapshot(roomId),
        }, playerId);

        console.log(`Player ${playerId} (${playerName}) joined ${roomId} — ${room.players.size} players`);

        // Start game when 2+ players are in the room
        if (room.players.size >= 2 && !room.started) {
          tryStartRoom(roomId);
        }

        // If only 1 player, tell them to wait
        if (room.players.size === 1) {
          sendToPlayer(ws, { type: 'waiting' });
        }
        break;
      }

      // ── Player sends their game state each frame ──
      case 'state': {
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        const player = room.players.get(playerId);
        if (!player) return;

        // Update server-side state
        player.x         = msg.x;
        player.y         = msg.y;
        player.isSliding = msg.isSliding;
        player.onGround  = msg.onGround;
        player.legAngle  = msg.legAngle;
        player.score     = msg.score;

        // Relay to all other players in the room
        broadcastToRoom(roomId, {
          type:      'state',
          id:        playerId,
          x:         msg.x,
          y:         msg.y,
          isSliding: msg.isSliding,
          onGround:  msg.onGround,
          legAngle:  msg.legAngle,
          score:     msg.score,
        }, playerId);
        break;
      }

      // ── Player died ──
      case 'died': {
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        const player = room.players.get(playerId);
        if (player) {
          player.alive = false;
          player.score = msg.score || player.score;
        }
        broadcastToRoom(roomId, {
          type:  'player_died',
          id:    playerId,
          name:  playerName,
          score: Math.floor(player?.score || 0),
        });
        console.log(`Player ${playerId} died in ${roomId}`);
        checkRoomWinner(roomId);
        break;
      }
    }
  });

  ws.on('close', () => {
    console.log(`Player ${playerId} disconnected`);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    room.players.delete(playerId);

    broadcastToRoom(roomId, {
      type: 'player_left',
      id:   playerId,
      name: playerName,
    });

    // If room is now empty, delete it
    if (room.players.size === 0) {
      if (room.startTimer) clearTimeout(room.startTimer);
      rooms.delete(roomId);
      console.log(`Room ${roomId} deleted (empty)`);
    } else {
      checkRoomWinner(roomId);
    }
  });

  ws.on('error', (err) => console.error(`WS error for player ${playerId}:`, err));
});

// ── Start Listening ───────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`\n🕹️  Stickman Run server running!`);
  console.log(`   Open http://localhost:${PORT} in your browser`);
  console.log(`   Share your local IP for LAN play\n`);
});
