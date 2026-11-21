// Multiplayer through a WebSim room (docs/web.md, crates/horizon-client/src/web_net.rs).
//
// The game speaks its own protocol over in-memory pipes; this file carries
// those bytes between players through the room. A world opened to LAN is
// announced in the room's presence, and shows up in every player's
// Multiplayer screen (LAN list) as `websim:<host's client id>`.
//
// Messages (all with `to`, the room member they are for):
//   hz-open  {conn, p}   a guest asks to join the host's world; `p` proves the
//                        guest holds the access key (see `proof`)
//   hz-data  {conn, d}   bytes, base64, in order
//   hz-close {conn}      that connection ended
// `conn` is the guest's number for the connection; the host tells guests
// apart by who sent it.
//
// Outside WebSim (tests, `?room=local`), tabs of one browser share a room
// through a BroadcastChannel.
//
// Room messages reach every member (`to` is only a filter), and members can be
// anyone who opened the page. So: a host takes only guests who prove they hold
// the access key (a hash of the key with both members' ids, which the room
// stamps on every message, so a copied proof is no use to anyone else); it
// takes few connections per member and in all, and caps what waits unread;
// everything read from the room is checked before use.

const CHUNK = 48 * 1024; // bytes per message, before base64
const MAX_DATA = Math.ceil(CHUNK / 3) * 4; // the longest `d` we send
const PER_MEMBER = 2; // connections one member may have open to this page
const MAX_CONNECTIONS = 12;
const MAX_WAITING = 1 << 20; // bytes held for a guest still proving itself
const MAX_MOTD = 80;

let room = null;
let exports = null;
let nextConn = 1;
const byWire = new Map(); // `${peer}:${wireConn}` -> local conn id
const byLocal = new Map(); // local conn id -> { peer, wire }
let hostingMotd = '';
let secret = '';

const isConn = (n) => Number.isInteger(n) && n > 0 && n < 2 ** 31;

// A room name as the game's player name (boot.js does the same for this page's player).
const playerName = (username) => String(username).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 16).padEnd(3, '_');

// The guest's proof: SHA-256 of the access key with the host's and the guest's room ids.
async function proof(host, guest) {
  const data = new TextEncoder().encode(`horizon-room\n${secret}\n${host}\n${guest}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}

const toBase64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

// ---- rooms ----
async function websimRoom() {
  const socket = new globalThis.WebsimSocket();
  await socket.initialize();
  const listeners = [];
  socket.onmessage = (event) => {
    const data = event?.data;
    if (data && data.to === socket.clientId) listeners.forEach((f) => f(data.clientId, data));
  };
  return {
    id: socket.clientId,
    named: true,
    nameOf: (id) => socket.peers?.[id]?.username,
    send: (message) => socket.send(message),
    onMessage: (f) => listeners.push(f),
    setPresence: (presence) => socket.updatePresence(presence),
    members() {
      return Object.entries(socket.presence || {}).map(([id, presence]) => ({
        id, presence, name: socket.peers?.[id]?.username,
      }));
    },
  };
}

function localRoom() {
  const id = Math.random().toString(36).slice(2, 10);
  const channel = new BroadcastChannel('horizon-room');
  const listeners = [];
  const presences = new Map();
  let mine = {};
  const announce = () => channel.postMessage({ type: 'presence', from: id, presence: mine });
  channel.onmessage = ({ data }) => {
    if (data.type === 'presence') {
      presences.set(data.from, data.presence);
      if (data.ask) announce();
    } else if (data.type === 'bye') presences.delete(data.from);
    else if (data.to === id) listeners.forEach((f) => f(data.from, data));
  };
  channel.postMessage({ type: 'presence', from: id, presence: mine, ask: true });
  addEventListener('pagehide', () => channel.postMessage({ type: 'bye', from: id }));
  return {
    id,
    send: (message) => channel.postMessage({ ...message, from: id }),
    onMessage: (f) => listeners.push(f),
    setPresence(presence) { mine = presence; announce(); },
    members: () => [...presences].map(([peer, presence]) => ({ id: peer, presence })),
  };
}

// ---- the game's side (horizonNet.* are called from Rust) ----
function forget(conn) {
  const link = byLocal.get(conn);
  if (!link) return null;
  byLocal.delete(conn);
  byWire.delete(`${link.peer}:${link.wire}`);
  return link;
}

globalThis.horizonNet = {
  send(conn, data) {
    const link = byLocal.get(conn);
    if (!link || !room) return;
    if (link.sending) {
      // The open is still on its way (the proof is hashed first).
      link.sending.push(data.slice());
      return;
    }
    for (let i = 0; i < data.length; i += CHUNK) {
      room.send({ type: 'hz-data', to: link.peer, conn: link.wire, d: toBase64(data.subarray(i, i + CHUNK)) });
    }
  },
  close(conn) {
    const link = forget(conn);
    if (link && room) room.send({ type: 'hz-close', to: link.peer, conn: link.wire });
  },
  open(peer) {
    const conn = nextConn++;
    const link = { peer, wire: conn, sending: [] };
    byLocal.set(conn, link);
    byWire.set(`${peer}:${conn}`, conn);
    if (!room) {
      setTimeout(() => { forget(conn); exports?.horizon_net_closed(conn); }, 0);
      return conn;
    }
    proof(peer, room.id).then((p) => {
      room.send({ type: 'hz-open', to: peer, conn, p });
      const waiting = link.sending;
      link.sending = null;
      for (const data of waiting) globalThis.horizonNet.send(conn, data);
    });
    return conn;
  },
  hosting(motd) {
    hostingMotd = motd;
    room?.setPresence(motd ? { hz: { motd } } : {});
  },
  games() {
    if (!room) return '';
    const clean = (text, max) => String(text).replace(/[\u0000-\u001f\u007f\u00a7]/g, ' ').slice(0, max).trim();
    return room.members()
      .filter((m) => m.id !== room.id && typeof m.id === 'string' && /^[\w-]{1,64}$/.test(m.id)
        && typeof m.presence?.hz?.motd === 'string')
      .map((m) => {
        // Whose world it is comes from the room, not from what the world says about itself.
        const by = m.name ? ` (${clean(m.name, 24)})` : '';
        return `${clean(m.presence.hz.motd, MAX_MOTD)}${by}\twebsim:${m.id}`;
      })
      .join('\n');
  },
};

function deliver(conn, link, bytes) {
  if (link.waiting) {
    link.waitingBytes += bytes.length;
    if (link.waitingBytes > MAX_WAITING) refuse(conn, link);
    else link.waiting.push(bytes);
  } else exports.horizon_net_deliver(conn, bytes);
}

function refuse(conn, link) {
  forget(conn);
  room.send({ type: 'hz-close', to: link.peer, conn: link.wire });
}

async function onOpen(from, message) {
  const open = [...byLocal.values()];
  if (open.length >= MAX_CONNECTIONS || open.filter((l) => l.peer === from).length >= PER_MEMBER) {
    room.send({ type: 'hz-close', to: from, conn: message.conn });
    return;
  }
  const conn = nextConn++;
  const link = { peer: from, wire: message.conn, waiting: [], waitingBytes: 0 };
  byLocal.set(conn, link);
  byWire.set(`${from}:${message.conn}`, conn);
  const expected = await proof(room.id, from);
  if (byLocal.get(conn) !== link) return; // closed meanwhile
  // In a WebSim room a guest plays under their own WebSim name, never the host's.
  let name = '';
  if (room.named) {
    const theirs = room.nameOf(from);
    const mine = room.nameOf(room.id);
    name = typeof theirs === 'string' && theirs ? playerName(theirs) : '';
    if (!name || (typeof mine === 'string' && playerName(mine).toLowerCase() === name.toLowerCase())) name = null;
  }
  if (message.p !== expected || !hostingMotd || name === null || !exports.horizon_net_accept(conn, name)) {
    refuse(conn, link);
    return;
  }
  const waiting = link.waiting;
  link.waiting = null;
  for (const bytes of waiting) exports.horizon_net_deliver(conn, bytes);
}

function onMessage(from, message) {
  if (typeof from !== 'string' || !message || !isConn(message.conn)) return;
  const conn = byWire.get(`${from}:${message.conn}`);
  if (message.type === 'hz-open') {
    if (conn === undefined && typeof message.p === 'string') onOpen(from, message);
  } else if (message.type === 'hz-data') {
    if (conn === undefined || typeof message.d !== 'string' || message.d.length > MAX_DATA) return;
    let bytes;
    try {
      bytes = fromBase64(message.d);
    } catch {
      return;
    }
    deliver(conn, byLocal.get(conn), bytes);
  } else if (message.type === 'hz-close') {
    if (conn !== undefined) {
      forget(conn);
      exports.horizon_net_closed(conn);
    }
  }
}

/// boot.js, once the game's module is up: join the room and start moving bytes.
export async function startNet(gameExports, accessKey) {
  exports = gameExports;
  secret = accessKey || '';
  const wanted = new URLSearchParams(location.search).get('room');
  try {
    if (wanted === 'local') room = localRoom();
    else if (globalThis.WebsimSocket) room = await websimRoom();
  } catch (e) {
    console.warn('Horizon: no WebSim room, multiplayer is off', e);
  }
  if (!room) return;
  globalThis.horizonNet.id = room.id;
  room.onMessage(onMessage);
  if (hostingMotd) room.setPresence({ hz: { motd: hostingMotd } });
  setInterval(() => exports.horizon_net_pump(), 8);
}
