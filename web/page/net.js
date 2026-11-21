// Multiplayer through a WebSim room (docs/web.md, crates/horizon-client/src/web_net.rs).
//
// The game speaks its own protocol over in-memory pipes; this file carries
// those bytes between players through the room. A world opened to LAN is
// announced in the room's presence, and shows up in every player's
// Multiplayer screen (LAN list) as `websim:<host's client id>`.
//
// Messages (all with `to`, the room member they are for):
//   hz-open  {conn}      a guest asks to join the host's world
//   hz-data  {conn, d}   bytes, base64, in order
//   hz-close {conn}      that connection ended
// `conn` is the guest's number for the connection; the host tells guests
// apart by who sent it.
//
// Outside WebSim (tests, `?room=local`), tabs of one browser share a room
// through a BroadcastChannel.

const CHUNK = 48 * 1024; // bytes per message, before base64

let room = null;
let exports = null;
let nextConn = 1;
const byWire = new Map(); // `${peer}:${wireConn}` -> local conn id
const byLocal = new Map(); // local conn id -> { peer, wire }
let hostingMotd = '';

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
    byLocal.set(conn, { peer, wire: conn });
    byWire.set(`${peer}:${conn}`, conn);
    if (room) room.send({ type: 'hz-open', to: peer, conn });
    else setTimeout(() => { forget(conn); exports?.horizon_net_closed(conn); }, 0);
    return conn;
  },
  hosting(motd) {
    hostingMotd = motd;
    room?.setPresence(motd ? { hz: { motd } } : {});
  },
  games() {
    if (!room) return '';
    return room.members()
      .filter((m) => m.id !== room.id && m.presence?.hz?.motd)
      .map((m) => `${m.presence.hz.motd.replace(/[\t\n]/g, ' ')}\twebsim:${m.id}`)
      .join('\n');
  },
};

function onMessage(from, message) {
  const key = `${from}:${message.conn}`;
  if (message.type === 'hz-open') {
    const conn = nextConn++;
    byLocal.set(conn, { peer: from, wire: message.conn });
    byWire.set(key, conn);
    if (!exports.horizon_net_accept(conn)) {
      forget(conn);
      room.send({ type: 'hz-close', to: from, conn: message.conn });
    }
  } else if (message.type === 'hz-data') {
    const conn = byWire.get(key);
    if (conn !== undefined) exports.horizon_net_deliver(conn, fromBase64(message.d));
  } else if (message.type === 'hz-close') {
    const conn = byWire.get(key);
    if (conn !== undefined) {
      forget(conn);
      exports.horizon_net_closed(conn);
    }
  }
}

/// boot.js, once the game's module is up: join the room and start moving bytes.
export async function startNet(gameExports) {
  exports = gameExports;
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
