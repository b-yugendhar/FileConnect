const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8081;

const app = express();
app.get('/health', (_, res) => res.json({ status: 'ok' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// rooms: Map<roomId, Set<WebSocket>>
const rooms = new Map();

wss.on('connection', (ws) => {
  let currentRoom = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const { type, roomId } = msg;
    if (!type || !roomId) return;

    if (type === 'JOIN') {
      currentRoom = roomId;
      if (!rooms.has(roomId)) rooms.set(roomId, new Set());
      rooms.get(roomId).add(ws);
      console.log(`Session joined room "${roomId}" (room size: ${rooms.get(roomId).size})`);

      // Notify all other peers in the room that someone joined
      broadcast(roomId, ws, JSON.stringify({ type: 'JOINED' }));

    } else if (['OFFER', 'ANSWER', 'ICE'].includes(type)) {
      broadcast(roomId, ws, raw.toString());
    }
  });

  ws.on('close', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      rooms.get(currentRoom).delete(ws);
      if (rooms.get(currentRoom).size === 0) {
        rooms.delete(currentRoom);
      }
    }
    console.log('Session closed');
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

function broadcast(roomId, sender, message) {
  const members = rooms.get(roomId);
  if (!members) return;
  for (const client of members) {
    if (client !== sender && client.readyState === 1 /* OPEN */) {
      client.send(message);
    }
  }
}

server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});
