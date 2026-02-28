// ─────────────────────────────────────────────────────────────
//  server.js  —  Stickman Run Multiplayer Server (v2)
//
//  New in v2:
//  - Rooms have custom names, passwords, and host info
//  - Clients can request full room list (lobby browser)
//  - Global leaderboard stored in memory (top 10 scores)
// ─────────────────────────────────────────────────────────────

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

// ── HTTP Server ───────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const filePath = path.join(__dirname, 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('index.html not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server: httpServer });

// ── Global Leaderboard (top 10, in-memory) ───────────────────
let leaderboard = [];

function updateLeaderboard(name, score) {
  leaderboard.push({ name, score: Math.floor(score), date: new Date().toISOString().slice(0, 10) });
  leaderboard.sort((a, b) => b.score - a.score);
  leaderboard = leaderboard.slice(0, 10);
}

// ── Room Store ────────────────────────────────────────────────
const rooms = new Map();
let nextPlayerId = 1;
const PLAYER_COLORS = ['#00d4ff', '#ff6b35', '#a8ff3e', '#ff3ef5'];
const MAX_PLAYERS = 4;

function makeRoomSnapshot(room) {
  const players = {};
  room.players.forEach((p, id) => {
    players[id] = {
      id, name: p.name, color: p.color,
      x: p.x, y: p.y, isSliding: p.isSliding,
      onGround: p.onGround, legAngle: p.legAngle,
      alive: p.alive, score: p.score,
    };
  });
  return { id: room.id, name: room.name, host: room.host, hasPassword: !!room.password, playerCount: room.players.size, maxPlayers: MAX_PLAYERS, started: room.started, players };
}

function getRoomList() {
  const list = [];
  rooms.forEach(room => {
    if (!room.started && room.players.size < MAX_PLAYERS) {
      list.push({ id: room.id, name: room.name, host: room.host, hasPassword: !!room.password, playerCount: room.players.size, maxPlayers: MAX_PLAYERS });
    }
  });
  return list;
}

function broadcastToRoom(roomId, message, excludeId = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  const data = JSON.stringify(message);
  room.players.forEach((player, id) => {
    if (id !== excludeId && player.ws.readyState === WebSocket.OPEN) player.ws.send(data);
  });
}

function broadcastRoomList() {
  const list = getRoomList();
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client._inLobby) {
      client.send(JSON.stringify({ type: 'room_list', rooms: list }));
    }
  });
}

function sendTo(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function checkRoomWinner(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const alive = [...room.players.values()].filter(p => p.alive);
  if (alive.length <= 1 && room.players.size > 1) {
    const winner = alive[0] || null;
    const scores = [...room.players.values()]
      .map(p => ({ id: p.id, name: p.name, score: Math.floor(p.score), color: p.color }))
      .sort((a, b) => b.score - a.score);
    if (scores[0]) updateLeaderboard(scores[0].name, scores[0].score);
    broadcastToRoom(roomId, { type: 'game_over', winnerId: winner?.id || null, winnerName: winner?.name || null, scores, leaderboard });
    setTimeout(() => { rooms.delete(roomId); broadcastRoomList(); }, 10000);
  }
}

function tryStartRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.started) return;
  broadcastToRoom(roomId, { type: 'countdown', players: makeRoomSnapshot(room).players, playerCount: room.players.size });
  room.startTimer = setTimeout(() => {
    if (!rooms.has(roomId)) return;
    room.started = true;
    room.seed = Math.floor(Math.random() * 99999);
    broadcastToRoom(roomId, { type: 'start', seed: room.seed });
    broadcastRoomList();
    console.log(`Room "${room.name}" started with ${room.players.size} players`);
  }, 3000);
}

function joinRoom(ws, playerId, roomId, playerName) {
  const room = rooms.get(roomId);
  const colorIndex = room.players.size % PLAYER_COLORS.length;
  const color = PLAYER_COLORS[colorIndex];
  ws._inLobby = false;
  room.players.set(playerId, { id: playerId, ws, name: playerName, color, x: 120, y: 240, isSliding: false, onGround: true, legAngle: 0, alive: true, score: 0 });
  sendTo(ws, { type: 'joined', id: playerId, color, roomId, roomName: room.name, players: makeRoomSnapshot(room).players });
  broadcastToRoom(roomId, { type: 'player_joined', id: playerId, name: playerName, color, players: makeRoomSnapshot(room).players }, playerId);
  if (room.players.size === 1) sendTo(ws, { type: 'waiting' });
  else if (room.players.size >= 2 && !room.started) tryStartRoom(roomId);
  broadcastRoomList();
  console.log(`Player ${playerId} (${playerName}) joined room "${room.name}" — ${room.players.size} players`);
}

// ── Connection Handler ────────────────────────────────────────
wss.on('connection', (ws) => {
  const playerId = nextPlayerId++;
  let roomId = null;
  let playerName = `Player ${playerId}`;
  ws._inLobby = true;

  console.log(`Player ${playerId} connected`);
  sendTo(ws, { type: 'room_list', rooms: getRoomList() });
  sendTo(ws, { type: 'leaderboard', entries: leaderboard });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'get_rooms':
        sendTo(ws, { type: 'room_list', rooms: getRoomList() });
        break;

      case 'get_leaderboard':
        sendTo(ws, { type: 'leaderboard', entries: leaderboard });
        break;

      case 'create_room': {
        playerName = (msg.playerName || playerName).slice(0, 20);
        const roomName = (msg.roomName || `${playerName}'s Room`).slice(0, 30);
        const password = (msg.password || '').slice(0, 20);
        const newRoomId = `room_${Date.now()}_${playerId}`;
        rooms.set(newRoomId, { id: newRoomId, name: roomName, host: playerName, password, players: new Map(), started: false, startTimer: null, seed: 0 });
        roomId = newRoomId;
        joinRoom(ws, playerId, roomId, playerName);
        break;
      }

      case 'join_room': {
        playerName = (msg.playerName || playerName).slice(0, 20);
        const targetRoom = rooms.get(msg.roomId);
        if (!targetRoom) { sendTo(ws, { type: 'error', message: 'Room not found.' }); return; }
        if (targetRoom.started) { sendTo(ws, { type: 'error', message: 'Game already started.' }); return; }
        if (targetRoom.players.size >= MAX_PLAYERS) { sendTo(ws, { type: 'error', message: 'Room is full.' }); return; }
        if (targetRoom.password && targetRoom.password !== msg.password) { sendTo(ws, { type: 'error', message: 'Wrong password.' }); return; }
        roomId = msg.roomId;
        joinRoom(ws, playerId, roomId, playerName);
        break;
      }

      case 'state': {
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        const player = room.players.get(playerId);
        if (!player) return;
        player.x = msg.x; player.y = msg.y; player.isSliding = msg.isSliding;
        player.onGround = msg.onGround; player.legAngle = msg.legAngle; player.score = msg.score;
        broadcastToRoom(roomId, { type: 'state', id: playerId, x: msg.x, y: msg.y, isSliding: msg.isSliding, onGround: msg.onGround, legAngle: msg.legAngle, score: msg.score }, playerId);
        break;
      }

      case 'died': {
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        const player = room.players.get(playerId);
        if (player) { player.alive = false; player.score = msg.score || player.score; }
        broadcastToRoom(roomId, { type: 'player_died', id: playerId, name: playerName, score: Math.floor(player?.score || 0) });
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
    broadcastToRoom(roomId, { type: 'player_left', id: playerId, name: playerName });
    if (room.players.size === 0) { if (room.startTimer) clearTimeout(room.startTimer); rooms.delete(roomId); broadcastRoomList(); }
    else checkRoomWinner(roomId);
  });

  ws.on('error', (err) => console.error(`WS error player ${playerId}:`, err));
});

httpServer.listen(PORT, () => {
  console.log(`\n🕹️  Stickman Run server running!`);
  console.log(`   Local:  http://localhost:${PORT}\n`);
});