import express from 'express';
import { Server } from 'socket.io';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { join } from 'path';
import { createServer } from 'http';
import { availableParallelism } from 'os';
import cluster from 'cluster';
import { createAdapter, setupPrimary } from '@socket.io/cluster-adapter';
import { fileURLToPath } from 'url';
import path from 'path';

// Equivalent of __filename and __dirname in CommonJS
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (cluster.isPrimary) {
  const numCPUs = availableParallelism();
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork({ PORT: 3000 + i });
  }
  setupPrimary();
} else {
  (async () => {
    const db = await open({
      filename: 'chat.db',
      driver: sqlite3.Database,
    });

    // Messages table now includes room
    await db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_offset TEXT UNIQUE,
        content TEXT,
        room TEXT
      );
    `);

    const app = express();
    const server = createServer(app);
    const io = new Server(server, {
      connectionStateRecovery: {},
      adapter: createAdapter(),
    });

    app.get('/', (req, res) => {
      res.sendFile(join(__dirname, 'index.html'));
    });

    io.on('connection', async (socket) => {
      // --- Default room
      socket.join('lobby');
      socket.data.room = 'lobby';

      // --- Nickname
      socket.on('set nickname', (nickname, callback) => {
        socket.data.nickname = nickname;
        callback?.();
      });

      // --- Room switching
      socket.on('join room', async (roomName) => {
        socket.leave(socket.data.room);
        socket.join(roomName);
        socket.data.room = roomName;
        socket.emit('system message', `You joined room: ${roomName}`);

        // Send past messages for the new room
        try {
          await db.each(
            'SELECT id, content FROM messages WHERE room = ?',
            [roomName],
            (_err, row) => {
              socket.emit('chat message', row.content, row.id);
            },
          );
        } catch (e) {
          console.error('Failed to send room history:', e);
        }
      });

      // --- Chat messages
      socket.on('chat message', async (msg, clientOffset, callback) => {
        if (!socket.data.nickname) {
          callback?.('Please set a nickname first!');
          return;
        }

        const fullMessage = `${socket.data.nickname}: ${msg}`;

        let result;
        try {
          result = await db.run(
            'INSERT INTO messages (content, client_offset, room) VALUES (?, ?, ?)',
            fullMessage,
            clientOffset,
            socket.data.room
          );
        } catch (e) {
          if (
            e instanceof Error &&
            'code' in e &&
            (e as { code?: string }).code === 'SQLITE_CONSTRAINT'
          ) {
            callback?.();
          }
          return;
        }

        // Emit to current room only
        io.to(socket.data.room).emit('chat message', fullMessage, result.lastID);
        callback?.();
      });

      // --- Recovery (room-specific)
      if (!socket.recovered) {
        try {
          await db.each(
            'SELECT id, content FROM messages WHERE id > ? AND room = ?',
            [socket.handshake.auth.serverOffset || 0, socket.data.room],
            (_err, row) => {
              socket.emit('chat message', row.content, row.id);
            },
          );
        } catch (e) {
          console.error('Recovery failed:', e);
        }
      }
    });

    const port = process.env.PORT || 3000;
    server.listen(port, () => {
      console.log(`server running at http://localhost:${port}`);
    });
  })();
}
