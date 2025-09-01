import express from 'express';
import { Server } from 'socket.io';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { join, dirname } from 'path';
import { createServer } from 'http';
import { availableParallelism } from 'os';
import cluster from 'cluster';
import { createAdapter, setupPrimary } from '@socket.io/cluster-adapter';
import { fileURLToPath } from 'url';

// Equivalent of __filename and __dirname in CommonJS
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

if (cluster.isPrimary) {
  const numCPUs = availableParallelism();
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork({ PORT: 3000 + i }); // Each worker gets a different port
  }
  setupPrimary();
} else {
  (async () => {
    const db = await open({
      filename: 'chat.db',
      driver: sqlite3.Database,
    });

    // Messages table now includes room + nickname
    await db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_offset TEXT UNIQUE,
        nickname TEXT,
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

    app.use(express.static(join(__dirname, '../public')));

    app.get('/', (req, res) => {
      res.sendFile(join(__dirname, '../public/index.html'));
    });

    io.on('connection', async (socket) => {
      // Default room
      socket.join('general');
      socket.data.room = 'general';

      // --- Nickname
      socket.on('set nickname', (nickname, callback) => {
        socket.data.nickname = nickname;

        // Tell only this user their nickname
        socket.emit('system message', `Your nickname is now: ${nickname}`);

        callback?.();
      });

      // --- Typing events
      socket.on('typing', () => {
        socket.to(socket.data.room).emit('user typing', socket.data.nickname);
      });

      socket.on('stop typing', () => {
        socket.to(socket.data.room).emit('user stop typing', socket.data.nickname);
      });

      // --- Room switching
      socket.on('join room', async (roomName) => {
        socket.leave(socket.data.room);
        socket.join(roomName);
        socket.data.room = roomName;
        socket.emit('system message', `You joined room: ${roomName}`);

        try {
          await db.each(
            'SELECT id, nickname, content FROM messages WHERE room = ?',
            [roomName],
            (_err, row) => {
              socket.emit('chat message', {
                nickname: row.nickname,
                text: row.content,
                avatar: `https://robohash.org/${encodeURIComponent(row.nickname)}.png?size=50x50`,
              }, row.id);
            }
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

        const nickname = socket.data.nickname;
        const messageText = msg;

        let result;
        try {
          result = await db.run(
            'INSERT INTO messages (content, client_offset, room, nickname) VALUES (?, ?, ?, ?)',
            messageText,
            clientOffset,
            socket.data.room,
            nickname,
          );
        } catch (e) {
          if (e instanceof Error && 'code' in e && (e).code === 'SQLITE_CONSTRAINT') {
            callback?.();
          }
          return;
        }

        io.to(socket.data.room).emit(
          'chat message',
          {
            nickname,
            text: messageText,
            avatar: 'https://placecats.com/50/50',
          },
          result.lastID,
        );

        callback?.();
      });

      // --- Recovery (room-specific)
      if (!socket.recovered) {
        try {
          await db.each(
            'SELECT id, nickname, content FROM messages WHERE id > ? AND room = ?',
            [socket.handshake.auth.serverOffset || 0, socket.data.room],
            (_err, row) => {
              socket.emit('chat message', {
                nickname: row.nickname,
                text: row.content,
                avatar: `https://placecats.com/50/50`,
              }, row.id);
            }
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
