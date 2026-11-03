'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, game: 'Werewolf Nightfall' }));

const rooms = new Map();
let botSerial = 1;
const ROLE_NAMES = ['Werewolf', 'Seer', 'Doctor', 'Villager'];
const SPECIAL_ROLES = new Set(['Werewolf', 'Seer', 'Doctor']);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const shuffle = arr => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const cleanName = value => String(value || '').trim().replace(/[<>]/g, '').slice(0, 18);

function normalizeSettings(raw = {}) {
  const humanCount = Math.max(1, Math.min(12, Number.parseInt(raw.humanCount, 10) || 1));
  const botCount = Math.max(0, Math.min(15, Number.parseInt(raw.botCount, 10) || 0));
  const total = humanCount + botCount;
  if (total < 4 || total > 16) throw new Error('Jumlah pemain harus 4 sampai 16 orang (manusia + bot).');
  const werewolfCount = Math.max(1, Math.min(total - 1, Number.parseInt(raw.werewolfCount, 10) || 1));
  const seerCount = Math.max(0, Math.min(1, Number.parseInt(raw.seerCount, 10) || 0));
  const doctorCount = Math.max(0, Math.min(1, Number.parseInt(raw.doctorCount, 10) || 0));
  if (werewolfCount + seerCount + doctorCount > total - 1) {
    throw new Error('Jumlah peran khusus terlalu banyak untuk jumlah pemain.');
  }
  const difficulty = ['mudah', 'normal', 'sulit'].includes(raw.difficulty) ? raw.difficulty : 'normal';
  return { humanCount, botCount, werewolfCount, seerCount, doctorCount, difficulty, total };
}

function roomBySocket(socketId) {
  for (const room of rooms.values()) {
    if (room.players.some(p => p.id === socketId && p.kind === 'human')) return room;
  }
  return null;
}

function emitChat(room, name, text, kind = 'system') {
  io.to(room.code).emit('chatMessage', {
    name: String(name || '').slice(0, 20),
    text: String(text || '').slice(0, 350),
    kind,
    time: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
  });
}

function publicState(room, socketId) {
  const me = room.players.find(p => p.id === socketId);
  return {
    code: room.code,
    phase: room.phase,
    day: room.day,
    hostId: room.hostId,
    meId: socketId,
    myRole: me?.role || null,
    settings: room.settings,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      alive: p.alive,
      connected: p.kind === 'bot' ? true : p.connected,
      role: (room.phase === 'finished' || !p.alive) ? p.role : undefined
    })),
    voted: Boolean(room.votes[socketId]),
    myNightAction: Boolean(room.nightActions[socketId]),
    winner: room.winner || null,
    lastElimination: room.lastElimination || null
  };
}

function sendState(room) {
  for (const p of room.players) {
    if (p.kind === 'human' && p.connected) {
      io.to(p.id).emit('gameState', publicState(room, p.id));
    }
  }
}

function roleList(settings) {
  const list = [];
  for (let i = 0; i < settings.werewolfCount; i++) list.push('Werewolf');
  for (let i = 0; i < settings.seerCount; i++) list.push('Seer');
  for (let i = 0; i < settings.doctorCount; i++) list.push('Doctor');
  while (list.length < settings.total) list.push('Villager');
  return shuffle(list);
}

function living(room) { return room.players.filter(p => p.alive); }
function wolves(room) { return living(room).filter(p => p.role === 'Werewolf'); }
function findPlayer(room, id) { return room.players.find(p => p.id === id); }

function checkWinner(room) {
  const alive = living(room);
  const wolfCount = alive.filter(p => p.role === 'Werewolf').length;
  const nonWolfCount = alive.length - wolfCount;
  if (wolfCount === 0) room.winner = 'Warga';
  else if (wolfCount >= nonWolfCount) room.winner = 'Werewolf';
  else return false;
  room.phase = 'finished';
  emitChat(room, 'Sistem', `Permainan selesai. Pemenang: ${room.winner}!`, 'system');
  io.to(room.code).emit('gameOver', {
    winner: room.winner,
    players: room.players.map(p => ({ name: p.name, role: p.role, alive: p.alive }))
  });
  sendState(room);
  return true;
}

function botSuspect(room, bot) {
  const candidates = living(room).filter(p => p.id !== bot.id);
  if (!candidates.length) return null;
  if (room.settings.difficulty === 'mudah') return pick(candidates);
  const scored = candidates.map(p => ({ p, score: (bot.suspicion[p.id] || 0) + Math.random() * (room.settings.difficulty === 'sulit' ? 1.5 : 3) }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0].p;
}

function addSuspicionFromChat(room, sender, text) {
  const lower = text.toLowerCase();
  for (const bot of room.players.filter(p => p.kind === 'bot' && p.alive)) {
    for (const target of living(room)) {
      if (target.id === bot.id) continue;
      if (lower.includes(target.name.toLowerCase())) {
        bot.suspicion[target.id] = (bot.suspicion[target.id] || 0) + (sender.id === target.id ? 0.2 : 0.8);
      }
    }
  }
}

function botChat(room, bot, context = 'discussion') {
  if (room.phase !== 'day' || !bot.alive) return;
  const suspect = botSuspect(room, bot);
  const phrases = [
    () => suspect ? `Aku masih memperhatikan ${suspect.name}. Ada sesuatu yang terasa janggal.` : 'Kita perlu berpikir hati-hati sebelum voting.',
    () => suspect ? `Menurutku ${suspect.name} perlu menjelaskan sikapnya.` : 'Jangan asal menuduh, kita cari petunjuk dulu.',
    () => 'Coba ingat siapa yang paling banyak menghindari pertanyaan tadi.',
    () => 'Aku belum yakin. Aku ingin dengar pendapat pemain lain.',
    () => suspect ? `Aku tidak menuduh pasti, tapi gerak-gerik ${suspect.name} patut diperhatikan.` : 'Kita harus bekerja sama menemukan Werewolf.'
  ];
  let line = pick(phrases)();
  if (context === 'reply') line = pick([
    'Pendapatmu masuk akal, tapi kita tetap perlu bukti.',
    'Kenapa kamu berpikir begitu? Bisa jelaskan alasannya?',
    suspect ? `Aku justru masih curiga pada ${suspect.name}.` : 'Aku masih mengumpulkan informasi.',
    'Bisa jadi. Aku akan mempertimbangkannya saat voting.'
  ]);
  emitChat(room, bot.name, line, 'bot');
}

function scheduleBotDiscussion(room) {
  const marker = room.day;
  const bots = shuffle(room.players.filter(p => p.kind === 'bot' && p.alive));
  bots.forEach((bot, index) => {
    setTimeout(() => {
      if (room.phase === 'day' && room.day === marker && bot.alive) botChat(room, bot);
    }, 1800 + index * 2600 + Math.random() * 1600);
  });
}

function chooseBotNightAction(room, bot) {
  const allLiving = living(room);
  if (bot.role === 'Werewolf') {
    const targets = allLiving.filter(p => p.role !== 'Werewolf');
    if (!targets.length) return null;
    if (room.settings.difficulty === 'sulit') {
      // Bots use their accumulated suspicion, not hidden role information.
      const ranked = targets.map(p => ({ p, score: (bot.suspicion[p.id] || 0) + Math.random() * 2 }));
      ranked.sort((a, b) => b.score - a.score);
      return { action: 'kill', targetId: ranked[0].p.id };
    }
    return { action: 'kill', targetId: pick(targets).id };
  }
  if (bot.role === 'Seer') {
    const unknown = allLiving.filter(p => p.id !== bot.id);
    return unknown.length ? { action: 'inspect', targetId: pick(unknown).id } : null;
  }
  if (bot.role === 'Doctor') {
    const targets = allLiving.filter(p => p.id !== bot.id);
    return { action: 'protect', targetId: (Math.random() < 0.3 ? bot.id : (targets.length ? pick(targets).id : bot.id)) };
  }
  return null;
}

function allNightActionsDone(room) {
  return living(room).filter(p => SPECIAL_ROLES.has(p.role)).every(p => Boolean(room.nightActions[p.id]));
}

function resolveNight(room) {
  if (room.phase !== 'night' || !allNightActionsDone(room)) return;
  const wolfActions = living(room).filter(p => p.role === 'Werewolf').map(p => room.nightActions[p.id]).filter(Boolean);
  const tallies = {};
  wolfActions.forEach(a => { tallies[a.targetId] = (tallies[a.targetId] || 0) + 1; });
  let targetId = null;
  const max = Math.max(0, ...Object.values(tallies));
  if (max > 0) targetId = pick(Object.keys(tallies).filter(id => tallies[id] === max));
  const doctor = living(room).find(p => p.role === 'Doctor');
  const protectedId = doctor ? room.nightActions[doctor.id]?.targetId : null;
  const seer = living(room).find(p => p.role === 'Seer');
  if (seer) {
    const action = room.nightActions[seer.id];
    const target = action && findPlayer(room, action.targetId);
    if (seer.kind === 'human' && target) io.to(seer.id).emit('privateInfo', `Hasil penglihatan: ${target.name} adalah ${target.role === 'Werewolf' ? 'Werewolf' : 'bukan Werewolf'}.`);
  }
  room.lastElimination = null;
  if (targetId && targetId !== protectedId) {
    const victim = findPlayer(room, targetId);
    if (victim && victim.alive) {
      victim.alive = false;
      room.lastElimination = victim.name;
      emitChat(room, 'Sistem', `${victim.name} tereliminasi tadi malam. Perannya: ${victim.role}.`, 'system');
    }
  } else {
    emitChat(room, 'Sistem', 'Malam berlalu tanpa korban.', 'system');
  }
  if (checkWinner(room)) return;
  room.phase = 'day';
  room.votes = {};
  room.nightActions = {};
  emitChat(room, 'Sistem', `Hari ${room.day} dimulai. Diskusi dibuka!`, 'system');
  sendState(room);
  scheduleBotDiscussion(room);
}

function scheduleBotNightActions(room) {
  const marker = room.day;
  const bots = room.players.filter(p => p.kind === 'bot' && p.alive && SPECIAL_ROLES.has(p.role));
  bots.forEach((bot, index) => {
    setTimeout(() => {
      if (room.phase !== 'night' || room.day !== marker || !bot.alive) return;
      const action = chooseBotNightAction(room, bot);
      if (action) room.nightActions[bot.id] = action;
      resolveNight(room);
    }, 900 + index * 700 + Math.random() * 900);
  });
  resolveNight(room);
}

function botVoteTarget(room, bot) {
  const candidates = living(room).filter(p => p.id !== bot.id);
  if (!candidates.length) return null;
  if (room.settings.difficulty === 'mudah') return pick(candidates);
  // Suspicion can be influenced by discussion; bot does not inspect true roles.
  const ranked = candidates.map(p => ({ p, score: (bot.suspicion[p.id] || 0) + Math.random() * (room.settings.difficulty === 'sulit' ? 1.2 : 3) }));
  ranked.sort((a, b) => b.score - a.score);
  return ranked[0].p;
}

function finishVoting(room) {
  if (room.phase !== 'voting') return;
  const alive = living(room);
  if (!alive.every(p => room.votes[p.id])) return;
  const counts = {};
  Object.values(room.votes).forEach(id => { counts[id] = (counts[id] || 0) + 1; });
  const max = Math.max(0, ...Object.values(counts));
  const top = Object.keys(counts).filter(id => counts[id] === max);
  const history = Object.entries(room.votes).map(([from, to]) => ({
    voter: findPlayer(room, from)?.name || 'Pemain keluar',
    target: findPlayer(room, to)?.name || 'Tidak diketahui'
  }));
  io.to(room.code).emit('votingHistory', history);
  if (top.length === 1) {
    const eliminated = findPlayer(room, top[0]);
    if (eliminated && eliminated.alive) {
      eliminated.alive = false;
      room.lastElimination = eliminated.name;
      emitChat(room, 'Sistem', `${eliminated.name} tereliminasi melalui voting. Perannya: ${eliminated.role}.`, 'system');
    }
  } else {
    emitChat(room, 'Sistem', 'Hasil voting seri. Tidak ada yang tereliminasi.', 'system');
  }
  if (checkWinner(room)) return;
  room.day += 1;
  room.phase = 'night';
  room.votes = {};
  room.nightActions = {};
  emitChat(room, 'Sistem', `Malam ${room.day} tiba. Semua pemain dengan peran khusus, pilih aksi.`, 'system');
  sendState(room);
  scheduleBotNightActions(room);
}

function startVoting(room) {
  if (room.phase !== 'day') return;
  room.phase = 'voting';
  room.votes = {};
  emitChat(room, 'Sistem', 'Voting dimulai. Pilih satu pemain yang ingin kamu keluarkan.', 'system');
  sendState(room);
  const bots = living(room).filter(p => p.kind === 'bot');
  bots.forEach((bot, index) => {
    setTimeout(() => {
      if (room.phase !== 'voting' || !bot.alive || room.votes[bot.id]) return;
      const target = botVoteTarget(room, bot);
      if (target) room.votes[bot.id] = target.id;
      finishVoting(room);
      sendState(room);
    }, 1200 + index * 900 + Math.random() * 1000);
  });
}

io.on('connection', socket => {
  socket.on('createRoom', payload => {
    try {
      const name = cleanName(payload?.name);
      if (!name) throw new Error('Masukkan nama pemain.');
      const settings = normalizeSettings(payload?.settings);
      const code = Math.random().toString(36).slice(2, 7).toUpperCase();
      const room = {
        code, hostId: socket.id, settings,
        players: [{ id: socket.id, name, kind: 'human', alive: true, connected: true, role: null, suspicion: {} }],
        phase: 'waiting', day: 1, votes: {}, nightActions: {}, winner: null, lastElimination: null
      };
      rooms.set(code, room);
      socket.join(code);
      socket.emit('roomCreated', code);
      emitChat(room, 'Sistem', `Room ${code} dibuat. Bagikan kode kepada temanmu.`, 'system');
      sendState(room);
    } catch (err) { socket.emit('notice', err.message); }
  });

  socket.on('joinRoom', payload => {
    const code = String(payload?.code || '').trim().toUpperCase();
    const room = rooms.get(code);
    const name = cleanName(payload?.name);
    if (!room || room.phase !== 'waiting') return socket.emit('notice', 'Room tidak ditemukan atau permainan sudah dimulai.');
    if (!name) return socket.emit('notice', 'Masukkan nama pemain.');
    if (room.players.filter(p => p.kind === 'human').length >= room.settings.humanCount) return socket.emit('notice', 'Slot pemain manusia sudah penuh.');
    if (room.players.some(p => p.kind === 'human' && p.name.toLowerCase() === name.toLowerCase())) return socket.emit('notice', 'Nama itu sudah dipakai di room ini.');
    room.players.push({ id: socket.id, name, kind: 'human', alive: true, connected: true, role: null, suspicion: {} });
    socket.join(code);
    emitChat(room, 'Sistem', `${name} bergabung ke room.`, 'system');
    sendState(room);
  });

  socket.on('startGame', () => {
    const room = roomBySocket(socket.id);
    if (!room || room.hostId !== socket.id || room.phase !== 'waiting') return;
    const humans = room.players.filter(p => p.kind === 'human' && p.connected);
    if (humans.length !== room.settings.humanCount) return socket.emit('notice', `Menunggu ${room.settings.humanCount} pemain manusia. Saat ini ${humans.length}.`);
    const roles = roleList(room.settings);
    room.players.forEach((p, i) => { p.role = roles[i]; p.alive = true; p.suspicion = {}; });
    for (let i = 0; i < room.settings.botCount; i++) {
      room.players.push({ id: `bot_${botSerial++}`, name: pick(['Raka','Luna','Dimas','Nara','Bima','Sasha','Arka','Mira','Tara','Reno','Kai','Zara']) + (i + 1), kind: 'bot', alive: true, connected: true, role: null, suspicion: {} });
    }
    const allRoles = roleList(room.settings);
    room.players.forEach((p, i) => { p.role = allRoles[i]; });
    room.phase = 'night'; room.day = 1; room.votes = {}; room.nightActions = {};
    room.players.filter(p => p.kind === 'human').forEach(p => io.to(p.id).emit('roleInfo', { role: p.role, team: p.role === 'Werewolf' ? room.players.filter(x => x.role === 'Werewolf').map(x => x.name) : [] }));
    emitChat(room, 'Sistem', 'Permainan dimulai! 🌙 Malam pertama tiba.', 'system');
    sendState(room);
    scheduleBotNightActions(room);
  });

  socket.on('chat', payload => {
    const room = roomBySocket(socket.id);
    if (!room || !['day', 'voting'].includes(room.phase)) return;
    const player = findPlayer(room, socket.id);
    const text = String(payload?.text || '').trim().slice(0, 250);
    if (!player || !player.alive || !text) return;
    emitChat(room, player.name, text, 'human');
    addSuspicionFromChat(room, player, text);
    const bots = shuffle(living(room).filter(p => p.kind === 'bot')).slice(0, Math.min(2, room.settings.difficulty === 'sulit' ? 2 : 1));
    bots.forEach((bot, i) => setTimeout(() => {
      if (['day', 'voting'].includes(room.phase) && bot.alive) botChat(room, bot, 'reply');
    }, 900 + i * 850));
  });

  socket.on('nightAction', payload => {
    const room = roomBySocket(socket.id);
    if (!room || room.phase !== 'night') return;
    const player = findPlayer(room, socket.id);
    const target = findPlayer(room, payload?.targetId);
    const allowed = { Werewolf: 'kill', Seer: 'inspect', Doctor: 'protect' };
    if (!player || !player.alive || !target || !target.alive || allowed[player.role] !== payload?.action) return;
    if (player.role === 'Werewolf' && target.role === 'Werewolf') return socket.emit('notice', 'Werewolf tidak bisa memilih sesama Werewolf.');
    room.nightActions[player.id] = { action: payload.action, targetId: target.id };
    socket.emit('notice', 'Aksi malam berhasil dicatat.');
    resolveNight(room);
    sendState(room);
  });

  socket.on('beginVoting', () => {
    const room = roomBySocket(socket.id);
    if (!room || room.hostId !== socket.id) return;
    startVoting(room);
  });

  socket.on('vote', payload => {
    const room = roomBySocket(socket.id);
    if (!room || room.phase !== 'voting') return;
    const voter = findPlayer(room, socket.id);
    const target = findPlayer(room, payload?.targetId);
    if (!voter || !voter.alive || !target || !target.alive || voter.id === target.id) return;
    if (room.votes[voter.id]) return socket.emit('notice', 'Suaramu sudah tercatat.');
    room.votes[voter.id] = target.id;
    socket.emit('notice', 'Voting berhasil dicatat.');
    finishVoting(room);
    sendState(room);
  });

  socket.on('disconnect', () => {
    const room = roomBySocket(socket.id);
    if (!room) return;
    const player = findPlayer(room, socket.id);
    if (!player) return;
    player.connected = false;
    if (room.phase === 'waiting') room.players = room.players.filter(p => p.id !== socket.id);
    else player.alive = false;
    if (room.hostId === socket.id) {
      const next = room.players.find(p => p.kind === 'human' && p.connected);
      room.hostId = next?.id || null;
    }
    if (!room.players.some(p => p.kind === 'human' && p.connected)) {
      rooms.delete(room.code);
      return;
    }
    if (room.phase === 'voting') finishVoting(room);
    else if (room.phase === 'night') resolveNight(room);
    else if (room.phase === 'day') checkWinner(room);
    emitChat(room, 'Sistem', `${player.name} terputus dari permainan.`, 'system');
    sendState(room);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Werewolf Nightfall berjalan pada port ${PORT}`);
});
