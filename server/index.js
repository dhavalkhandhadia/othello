import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';

const app = express();
app.use(cors());
app.get('/', (_, res) => res.send('Othello server up'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  },
});

const PORT = process.env.PORT || 3001;

// --- Game constants & helpers ---
const EMPTY = 0, BLACK = 1, WHITE = 2;
const COLORS = { 1: 'BLACK', 2: 'WHITE' };
const DIRS = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1],          [0, 1],
  [1, -1],  [1, 0], [1, 1]
];

const makeBoard = () => {
  const b = Array.from({ length: 8 }, () => Array(8).fill(EMPTY));
  b[3][3] = WHITE; b[4][4] = WHITE; b[3][4] = BLACK; b[4][3] = BLACK;
  return b;
};

const inside = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;

function findFlips(board, color, r, c) {
  if (!inside(r, c) || board[r][c] !== EMPTY) return [];
  const opp = color === BLACK ? WHITE : BLACK;
  const flips = [];
  for (const [dr, dc] of DIRS) {
    let cr = r + dr, cc = c + dc;
    const line = [];
    while (inside(cr, cc) && board[cr][cc] === opp) {
      line.push([cr, cc]);
      cr += dr; cc += dc;
    }
    if (inside(cr, cc) && board[cr][cc] === color && line.length) {
      flips.push(...line);
    }
  }
  return flips;
}

function validMoves(board, color) {
  const moves = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const flips = findFlips(board, color, r, c);
      if (flips.length) moves.push({ r, c, flips });
    }
  }
  return moves;
}

function applyMove(board, color, r, c, flips) {
  const next = board.map(row => row.slice());
  next[r][c] = color;
  for (const [fr, fc] of flips) next[fr][fc] = color;
  return next;
}

function score(board) {
  let black = 0, white = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (board[r][c] === BLACK) black++;
      if (board[r][c] === WHITE) white++;
    }
  }
  return { black, white };
}

// --- Matchmaking & rooms ---
const queue = []; // sockets waiting for random
const rooms = new Map(); // roomId -> { board, turn, players: { [socketId]: color }, lastMove, winner }

function broadcastState(roomId, extra = {}) {
  const st = rooms.get(roomId);
  if (!st) return;
  const { board, turn, lastMove, winner } = st;
  io.to(roomId).emit('state', { board, turn, lastMove, winner, ...extra, score: score(board) });
}

function startRoom(roomId) {
  rooms.set(roomId, { board: makeBoard(), turn: BLACK, players: {}, lastMove: null, winner: null });
  broadcastState(roomId, { message: 'Game start' });
}

function joinRoom(socket, roomId, color) {
  socket.join(roomId);
  const st = rooms.get(roomId) || { board: makeBoard(), turn: BLACK, players: {}, lastMove: null, winner: null };
  st.players[socket.id] = color;
  rooms.set(roomId, st);
}

function otherColor(color) { return color === BLACK ? WHITE : BLACK; }

io.on('connection', (socket) => {
  socket.data.color = null;
  socket.data.roomId = null;

  socket.on('joinQueue', () => {
    if (queue.find(s => s.id === socket.id)) return;
    queue.push(socket);
    socket.emit('queue:joined');
    if (queue.length >= 2) {
      const a = queue.shift();
      const b = queue.shift();
      const roomId = `q-${Math.random().toString(36).slice(2, 8)}`;
      startRoom(roomId);
      // Assign colors randomly
      const colors = Math.random() < 0.5 ? [BLACK, WHITE] : [WHITE, BLACK];
      a.data.roomId = roomId; a.data.color = colors[0]; joinRoom(a, roomId, colors[0]);
      b.data.roomId = roomId; b.data.color = colors[1]; joinRoom(b, roomId, colors[1]);
      io.to(a.id).emit('matchFound', { roomId, color: colors[0] });
      io.to(b.id).emit('matchFound', { roomId, color: colors[1] });
      broadcastState(roomId, { message: 'Match found' });
    }
  });

  socket.on('cancelQueue', () => {
    const i = queue.findIndex(s => s.id === socket.id);
    if (i >= 0) queue.splice(i, 1);
    socket.emit('queue:cancelled');
  });

  socket.on('joinRoom', ({ roomId }) => {
    // Only allow up to 2 players
    const st = rooms.get(roomId);
    if (st && Object.keys(st.players).length >= 2) {
      socket.emit('room:full');
      return;
    }
    if (!st) startRoom(roomId);
    const existing = rooms.get(roomId);
    const takenColors = Object.values(existing.players);
    const myColor = takenColors.includes(BLACK) ? WHITE : BLACK;
    joinRoom(socket, roomId, myColor);
    socket.data.roomId = roomId; socket.data.color = myColor;
    socket.emit('roomJoined', { roomId, color: myColor });
    broadcastState(roomId, { message: `${COLORS[myColor]} joined` });
  });

  socket.on('place', ({ r, c }) => {
    const roomId = socket.data.roomId;
    const color = socket.data.color;
    if (!roomId || !rooms.has(roomId) || !color) return;
    const st = rooms.get(roomId);
    if (st.winner) return; // game over
    if (st.turn !== color) { io.to(socket.id).emit('invalid', { reason: 'Not your turn' }); return; }

    const flips = findFlips(st.board, color, r, c);
    if (!flips.length) { io.to(socket.id).emit('invalid', { reason: 'Invalid move' }); return; }

    st.board = applyMove(st.board, color, r, c, flips);
    st.lastMove = { r, c, flips, color };

    // Determine next turn / pass / end
    const opp = otherColor(color);
    const oppMoves = validMoves(st.board, opp);
    const myMoves = validMoves(st.board, color);

    if (oppMoves.length) {
      st.turn = opp;
    } else if (myMoves.length) {
      st.turn = color; // opponent passes
      io.to(roomId).emit('message', { type: 'pass', color: opp });
    } else {
      // both have no moves -> end
      const { black, white } = score(st.board);
      st.winner = black === white ? 'DRAW' : (black > white ? 'BLACK' : 'WHITE');
    }

    rooms.set(roomId, st);
    broadcastState(roomId);
  });

  socket.on('restart', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    startRoom(roomId);
  });

  socket.on('disconnect', () => {
    // Remove from queue
    const i = queue.findIndex(s => s.id === socket.id);
    if (i >= 0) queue.splice(i, 1);

    // Notify room
    const roomId = socket.data.roomId;
    if (roomId && rooms.has(roomId)) {
      io.to(roomId).emit('message', { type: 'left', color: COLORS[socket.data.color] });
      // Optional: end the game immediately
      const st = rooms.get(roomId);
      if (st && !st.winner) {
        st.winner = `${COLORS[otherColor(socket.data.color)]} (opponent left)`;
        rooms.set(roomId, st);
        broadcastState(roomId);
      }
    }
  });
});

server.listen(PORT, () => console.log(`Othello server listening on :${PORT}`));
