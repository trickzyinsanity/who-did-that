'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const express = require('express');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const ARGS = new Set(process.argv.slice(2));

const VOTE_MS = Number(process.env.VOTE_MS) || 45_000;
const EARLY_END_MS = 1_200; // short pause once everyone has voted, so the last pick registers on screen
const MIN_PLAYERS = 3;
const MIN_ANECDOTES = 2;
const MAX_PLAYERS = 16;
const MAX_NAME = 16;
const MAX_TEXT = 300;
const HOST_GRACE_MS = Number(process.env.HOST_GRACE_MS) || 8_000; // a host who refreshes keeps the role
const ROOM_TTL_MS = 30 * 60_000;
const AVATARS = ['🦊', '🐸', '🐼', '🦄', '🐙', '👽', '🤡', '🤠', '🦖', '🐷', '🐵', '🦁', '🐧', '👻', '🤖', '🐔'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

let publicUrl = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || null;

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.type('text').send('ok'));

const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 10_000,
  pingTimeout: 10_000,
  maxHttpBufferSize: 64 * 1024,
});

/** code -> room */
const rooms = new Map();

// ---------- small helpers ----------

const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');
const pickOne = (list) => list[crypto.randomInt(list.length)];
const clip = (value, max) => Array.from(value).slice(0, max).join('');

function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function cleanName(value) {
  if (typeof value !== 'string') return '';
  return clip(value.replace(/\s+/g, ' ').trim(), MAX_NAME).trim();
}

function cleanText(value) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return clip(text, MAX_TEXT).trim();
}

const cleanAvatar = (value) => (AVATARS.includes(value) ? value : pickOne(AVATARS));
const cleanCode = (value) => (typeof value === 'string' ? value.trim().toUpperCase() : '');

function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => pickOne(CODE_CHARS)).join('');
  } while (rooms.has(code));
  return code;
}

const byJoin = (a, b) => a.joinedAt - b.joinedAt;
const connectedPlayers = (room) => [...room.players.values()].filter((p) => p.connected).sort(byJoin);
const findByName = (room, name) =>
  [...room.players.values()].find((p) => p.name.toLocaleLowerCase() === name.toLocaleLowerCase());

// ---------- what each player is allowed to see ----------

function view(room, playerId) {
  const g = room.game;
  const state = {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    you: playerId,
    serverNow: Date.now(),
    publicUrl,
    rules: { minPlayers: MIN_PLAYERS, minAnecdotes: MIN_ANECDOTES, voteMs: VOTE_MS, maxText: MAX_TEXT },
    players: [...room.players.values()]
      .sort(byJoin)
      .map(({ id, name, avatar, connected }) => ({ id, name, avatar, connected })),
  };
  if (!g) return state;

  state.game = { no: g.no, participants: g.participants };

  if (room.phase === 'writing') {
    state.writing = { ready: [...g.anecdotes.keys()], mine: g.anecdotes.get(playerId) ?? null };
  } else if (room.phase === 'voting' || room.phase === 'verdict') {
    const c = g.cases[g.index];
    state.round = {
      index: g.index,
      total: g.cases.length,
      text: c.text,
      deadline: c.deadline,
      voters: g.participants.filter((id) => room.players.get(id)?.connected),
      voted: [...c.votes.keys()],
      myVote: c.votes.get(playerId) ?? null,
    };
    if (room.phase === 'verdict') {
      Object.assign(state.round, { tally: c.tally, accusedId: c.accusedId, tieIds: c.tieIds });
    }
  } else if (room.phase === 'reveal') {
    // The author is never sent. A correct verdict reveals it only because accusedId is the author.
    state.reveal = {
      revealed: g.revealed,
      cases: g.cases.map((c, i) => {
        const shown = i < g.revealed;
        return {
          text: c.text,
          accusedId: c.accusedId,
          votes: c.accusedId ? c.tally[c.accusedId] : 0,
          revealed: shown,
          correct: shown ? c.accusedId === c.authorId : null,
        };
      }),
    };
  }
  return state;
}

function broadcast(room) {
  for (const p of room.players.values()) {
    if (p.connected && p.socketId) io.to(p.socketId).emit('state', view(room, p.id));
  }
}

const broadcastAll = () => rooms.forEach(broadcast);

// ---------- seats and hosting ----------

function sessionOf(socket) {
  const room = rooms.get(socket.data.code);
  const player = room?.players.get(socket.data.pid);
  return player && player.socketId === socket.id ? { room, player } : null;
}

function ensureHost(room, force = false) {
  const host = room.players.get(room.hostId);
  if (host?.connected) {
    clearTimeout(room.hostTimer);
    room.hostTimer = null;
    return;
  }
  if (host && !force) return;
  const next = connectedPlayers(room)[0];
  if (next) room.hostId = next.id;
}

/** Marks the player behind this socket as gone, without touching the socket itself. */
function markGone(socket) {
  const session = sessionOf(socket);
  socket.data.code = null;
  socket.data.pid = null;
  if (!session) return;
  const { room, player } = session;
  player.connected = false;
  player.socketId = null;
  if (room.hostId === player.id) {
    clearTimeout(room.hostTimer);
    room.hostTimer = setTimeout(() => {
      room.hostTimer = null;
      ensureHost(room, true);
      broadcast(room);
    }, HOST_GRACE_MS);
  }
  if (room.phase === 'voting') scheduleEarlyEnd(room);
  if (!connectedPlayers(room).length) room.emptySince = Date.now();
  broadcast(room);
}

function seat(socket, room, player) {
  if (socket.data.code) markGone(socket);
  player.socketId = socket.id;
  player.connected = true;
  socket.data.code = room.code;
  socket.data.pid = player.id;
  room.emptySince = null;
  // Anyone who arrives while anecdotes are being written still gets to write one.
  if (room.phase === 'writing' && !room.game.participants.includes(player.id)) room.game.participants.push(player.id);
  ensureHost(room, !room.hostTimer);
}

function newRoom() {
  const room = {
    code: newCode(),
    hostId: null,
    players: new Map(),
    phase: 'lobby',
    game: null,
    gameNo: 0,
    timer: null,
    hostTimer: null,
    emptySince: null,
  };
  rooms.set(room.code, room);
  return room;
}

function newPlayer(room, name, avatar) {
  const player = {
    id: randomHex(6),
    token: randomHex(18),
    name,
    avatar,
    socketId: null,
    connected: false,
    joinedAt: Date.now(),
  };
  room.players.set(player.id, player);
  if (!room.hostId) room.hostId = player.id;
  return player;
}

const seatReply = (room, player) => ({ ok: true, code: room.code, playerId: player.id, token: player.token });

// ---------- game flow ----------

function startGame(room) {
  clearTimeout(room.timer);
  room.gameNo += 1;
  room.game = {
    no: room.gameNo,
    participants: connectedPlayers(room).map((p) => p.id),
    anecdotes: new Map(),
    cases: [],
    index: 0,
    revealed: 0,
  };
  room.phase = 'writing';
}

function endGame(room) {
  clearTimeout(room.timer);
  room.game = null;
  room.phase = 'lobby';
  // People who left mid-game no longer need their seat.
  for (const p of [...room.players.values()]) if (!p.connected && p.left) room.players.delete(p.id);
}

function startVoting(room) {
  const g = room.game;
  g.cases = shuffle(
    [...g.anecdotes].map(([authorId, text]) => ({
      authorId,
      text,
      votes: new Map(),
      deadline: 0,
      tally: {},
      accusedId: null,
      tieIds: [],
    })),
  );
  g.index = 0;
  beginRound(room);
}

function beginRound(room) {
  const c = room.game.cases[room.game.index];
  room.phase = 'voting';
  c.deadline = Date.now() + VOTE_MS;
  clearTimeout(room.timer);
  room.timer = setTimeout(() => endRound(room), VOTE_MS + 300);
}

function scheduleEarlyEnd(room) {
  const g = room.game;
  const c = g.cases[g.index];
  const voters = g.participants.filter((id) => room.players.get(id)?.connected);
  if (!voters.length || !voters.every((id) => c.votes.has(id))) return;
  clearTimeout(room.timer);
  room.timer = setTimeout(() => endRound(room), EARLY_END_MS);
}

function endRound(room) {
  if (room.phase !== 'voting') return;
  clearTimeout(room.timer);
  const c = room.game.cases[room.game.index];
  const tally = {};
  for (const suspect of c.votes.values()) tally[suspect] = (tally[suspect] || 0) + 1;
  const top = Math.max(0, ...Object.values(tally));
  const leaders = top > 0 ? Object.keys(tally).filter((id) => tally[id] === top) : [];
  c.tally = tally;
  c.tieIds = leaders.length > 1 ? leaders : [];
  c.accusedId = leaders.length ? pickOne(leaders) : null;
  room.phase = 'verdict';
  broadcast(room);
}

// ---------- actions (each returns an error code, or nothing on success) ----------

const actions = {
  'game:start': {
    host: true,
    run(room) {
      if (room.phase !== 'lobby') return 'wrong_phase';
      if (connectedPlayers(room).length < MIN_PLAYERS) return 'too_few_players';
      startGame(room);
    },
  },

  'anecdote:submit': {
    run(room, player, msg) {
      if (room.phase !== 'writing') return 'wrong_phase';
      const g = room.game;
      if (!g.participants.includes(player.id)) return 'not_in_game';
      const text = cleanText(msg.text);
      if (!text) return 'text_required';
      g.anecdotes.set(player.id, text);
      if (g.participants.every((id) => g.anecdotes.has(id))) startVoting(room);
    },
  },

  'anecdote:retract': {
    run(room, player) {
      if (room.phase !== 'writing') return 'wrong_phase';
      room.game.anecdotes.delete(player.id);
    },
  },

  'game:forceVote': {
    host: true,
    run(room) {
      if (room.phase !== 'writing') return 'wrong_phase';
      if (room.game.anecdotes.size < MIN_ANECDOTES) return 'too_few_anecdotes';
      startVoting(room);
    },
  },

  vote: {
    run(room, player, msg) {
      if (room.phase !== 'voting') return 'wrong_phase';
      const g = room.game;
      const suspect = msg.suspectId;
      if (!g.participants.includes(player.id)) return 'not_in_game';
      if (typeof suspect !== 'string' || suspect === player.id || !g.participants.includes(suspect)) return 'bad_vote';
      g.cases[g.index].votes.set(player.id, suspect);
      scheduleEarlyEnd(room);
    },
  },

  'game:next': {
    host: true,
    run(room) {
      if (room.phase !== 'verdict') return 'wrong_phase';
      const g = room.game;
      if (g.index + 1 < g.cases.length) {
        g.index += 1;
        beginRound(room);
      } else {
        room.phase = 'reveal';
        g.revealed = 0;
      }
    },
  },

  'reveal:next': {
    host: true,
    run(room) {
      if (room.phase !== 'reveal') return 'wrong_phase';
      const g = room.game;
      if (g.revealed < g.cases.length) g.revealed += 1;
    },
  },

  'game:again': {
    host: true,
    run(room) {
      if (room.phase !== 'reveal') return 'wrong_phase';
      if (connectedPlayers(room).length < MIN_PLAYERS) return 'too_few_players';
      startGame(room);
    },
  },

  'game:end': {
    host: true,
    run(room) {
      if (room.phase === 'lobby') return 'wrong_phase';
      endGame(room);
    },
  },

  'player:kick': {
    host: true,
    run(room, player, msg) {
      if (room.phase !== 'lobby') return 'wrong_phase';
      const target = room.players.get(msg.playerId);
      if (!target || target.id === player.id) return 'bad_player';
      room.players.delete(target.id);
      const s = target.socketId && io.sockets.sockets.get(target.socketId);
      if (s) {
        s.data.code = null;
        s.data.pid = null;
        s.emit('kicked');
      }
    },
  },

  'room:leave': {
    run(room, player, _msg, socket) {
      const g = room.game;
      const inGame = g?.participants.includes(player.id);
      const wroteSomething = g?.anecdotes.has(player.id);
      socket.data.code = null;
      socket.data.pid = null;
      player.connected = false;
      player.socketId = null;
      player.left = true;

      if (!inGame || (room.phase === 'writing' && !wroteSomething)) {
        // Nothing of theirs is in play, so they can disappear completely.
        room.players.delete(player.id);
        if (g) g.participants = g.participants.filter((id) => id !== player.id);
        if (room.phase === 'writing' && g.participants.length && g.participants.every((id) => g.anecdotes.has(id))) {
          startVoting(room);
        }
      }
      if (room.hostId === player.id) ensureHost(room, true);
      if (room.phase === 'voting') scheduleEarlyEnd(room);
      if (!connectedPlayers(room).length) room.emptySince = Date.now();
    },
  },
};

// ---------- sockets ----------

io.on('connection', (socket) => {
  const reply = (ack) => (typeof ack === 'function' ? ack : () => {});

  socket.on('room:create', (msg, ack) => {
    const done = reply(ack);
    const name = cleanName(msg?.name);
    if (!name) return done({ ok: false, error: 'name_required' });
    const room = newRoom();
    const player = newPlayer(room, name, cleanAvatar(msg?.avatar));
    seat(socket, room, player);
    done(seatReply(room, player));
    broadcast(room);
  });

  socket.on('room:join', (msg, ack) => {
    const done = reply(ack);
    const room = rooms.get(cleanCode(msg?.code));
    if (!room) return done({ ok: false, error: 'room_not_found' });
    const name = cleanName(msg?.name);
    if (!name) return done({ ok: false, error: 'name_required' });

    let player = findByName(room, name);
    if (player?.connected) return done({ ok: false, error: 'name_taken' });
    if (player) {
      // Someone lost their seat (new phone, cleared browser): typing the same name gives it back.
      player.token = randomHex(18);
      player.avatar = cleanAvatar(msg?.avatar);
      player.left = false;
    } else {
      if (room.players.size >= MAX_PLAYERS) return done({ ok: false, error: 'room_full' });
      player = newPlayer(room, name, cleanAvatar(msg?.avatar));
    }
    seat(socket, room, player);
    done(seatReply(room, player));
    broadcast(room);
  });

  socket.on('room:resume', (msg, ack) => {
    const done = reply(ack);
    const room = rooms.get(cleanCode(msg?.code));
    const player = room?.players.get(msg?.playerId);
    if (!player || player.token !== msg?.token) return done({ ok: false, error: 'room_not_found' });

    if (player.connected && player.socketId !== socket.id) {
      if (!msg.takeover) return done({ ok: false, error: 'in_use' });
      const old = io.sockets.sockets.get(player.socketId);
      player.socketId = null;
      if (old) {
        old.data.code = null;
        old.data.pid = null;
        old.emit('replaced');
      }
    }
    player.left = false;
    seat(socket, room, player);
    done(seatReply(room, player));
    broadcast(room);
  });

  for (const [event, action] of Object.entries(actions)) {
    socket.on(event, (msg, ack) => {
      const done = reply(ack);
      const session = sessionOf(socket);
      if (!session) return done({ ok: false, error: 'room_not_found' });
      const { room, player } = session;
      if (action.host && room.hostId !== player.id) return done({ ok: false, error: 'not_host' });
      const error = action.run(room, player, msg && typeof msg === 'object' ? msg : {}, socket);
      if (error) return done({ ok: false, error });
      done({ ok: true });
      broadcast(room);
    });
  }

  socket.on('disconnect', () => markGone(socket));
});

// Forget rooms nobody has been in for a while.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.emptySince && now - room.emptySince > ROOM_TTL_MS) {
      clearTimeout(room.timer);
      clearTimeout(room.hostTimer);
      rooms.delete(code);
    }
  }
}, 60_000).unref();

// ---------- online link (Cloudflare quick tunnel) ----------

function findCloudflared() {
  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const candidates = [path.join(__dirname, 'bin', exe)];
  if (process.platform === 'win32') {
    candidates.push(
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'cloudflared', exe),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'cloudflared', exe),
    );
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', exe));
  }
  const found = candidates.find((file) => fs.existsSync(file));
  if (found) return found;
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['cloudflared'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split(/\r?\n/).find(Boolean)?.trim() || null;
  } catch {
    return null;
  }
}

function banner(lines) {
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  const bar = '='.repeat(width);
  console.log(`\n  ${bar}\n${lines.map((l) => `    ${l}`).join('\n')}\n  ${bar}\n`);
}

function startTunnel() {
  const bin = findCloudflared();
  if (!bin) {
    banner([
      'No online link: cloudflared is not installed.',
      'The game works on this computer and your Wi-Fi only.',
      'To play with friends anywhere, run this once:',
      '  winget install --id Cloudflare.cloudflared',
      'then start the game again.',
    ]);
    return;
  }
  console.log('  Creating an online link for your friends (takes a few seconds)...');
  const child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const scan = (chunk) => {
    const match = String(chunk).match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/);
    if (!match || match[0] === publicUrl) return;
    publicUrl = match[0];
    banner(['Send this link to your friends:', '', publicUrl, '', 'Keep this window open while you play.']);
    broadcastAll();
  };
  child.stdout.on('data', scan);
  child.stderr.on('data', scan);
  child.on('error', (err) => console.error(`  Could not start cloudflared: ${err.message}`));
  child.on('exit', (code) => {
    console.log(`  The online link stopped (cloudflared exited with code ${code}).`);
    publicUrl = null;
    broadcastAll();
  });
  const stop = () => child.exitCode === null && child.kill();
  process.on('exit', stop);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      stop();
      process.exit(0);
    });
  }
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Is the game already open in another window?\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  const local = `http://localhost:${PORT}`;
  console.log(`\n  Who did that? is running at ${local}`);
  if (ARGS.has('--online')) startTunnel();
  else if (!publicUrl) console.log('  Local only. Use "npm run online" (or start-game.bat) to get a link for friends.\n');
  if (ARGS.has('--open')) openBrowser(local);
});
