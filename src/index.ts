import express from 'express';
import {Server} from 'socket.io';
import {open} from 'sqlite';
import sqlite3 from 'sqlite3';
import {join} from 'path';
import {createServer} from 'http';
import {availableParallelism} from 'os';
import cluster from 'cluster';
import {createAdapter, setupPrimary} from '@socket.io/cluster-adapter';
import {fileURLToPath} from 'url';

// Equivalent of __filename and __dirname in CommonJS, this was ass to figure out with typescript
const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..')

if (cluster.isPrimary) {
  const numCPUs = availableParallelism();
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork({PORT: 3000 + i}); // Each worker gets a different port
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

    app.use(express.static(join(__dirname, '../public')));

    app.get('/', (req, res) => {
      res.sendFile(join(__dirname, '../public/index.html'));
    });

    io.on('connection', async (socket) => {
      //  Default room
      socket.join('general');
      socket.data.room = 'general';

      // --- Nickname
      socket.on('set nickname', (nickname, callback) => {
        socket.data.nickname = nickname;

        // Tell only this user their nickname
        socket.emit('system message', `Your nickname is now: ${nickname}`);

        callback?.();
      });

      // When user starts typing
      socket.on('typing', () => {
        socket.to(socket.data.room).emit('user typing', socket.data.nickname);
      });

      // When user stops typing
      socket.on('stop typing', () => {
        socket
          .to(socket.data.room)
          .emit('user stop typing', socket.data.nickname);
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
            socket.data.room,
          );
        } catch (e) {
          if (
            e instanceof Error &&
            'code' in e &&
            (e as {code?: string}).code === 'SQLITE_CONSTRAINT'
          ) {
            callback?.();
          }
          return;
        }

        // Emit to current room only
        io.to(socket.data.room).emit(
          'chat message',
          fullMessage,
          result.lastID,
        );
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
