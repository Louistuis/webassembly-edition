//! WebSim multiplayer for the browser build (docs/web.md).
//!
//! The page has no sockets. Players reach each other through a WebSim room
//! (web/page/net.js), which carries the bytes of Horizon's own protocol: the
//! host's world, opened to LAN, accepts each guest as an in-memory pipe served
//! like an accepted socket (`conn::serve_pipe`), and a guest's game connects to
//! `websim:<host>` over a pipe as well. This module holds the page's ends of
//! those pipes and moves bytes between them and the room:
//!
//! - `horizon_net_deliver` / `horizon_net_closed`: the room's bytes in;
//! - `horizon_net_pump` (the page calls it every few milliseconds): the
//!   game's bytes out, through `horizonNet.send`;
//! - `horizon_net_accept`: a guest asks to join the world this page hosts.
//!
//! The connection handlers run as coroutine threads (web/std), so they wait
//! for bytes as they do on a socket.
use crate::lan::Shared;
use horizon_protocol::connection::Pipe;
use std::io::Write;
use std::sync::{Arc, Mutex};
use wasm_bindgen::prelude::wasm_bindgen;

#[wasm_bindgen]
extern "C" {
    /// Bytes for connection `conn`'s other end.
    #[wasm_bindgen(js_namespace = horizonNet, js_name = send)]
    fn js_send(conn: u32, data: &[u8]);
    /// Connection `conn` closed on this side.
    #[wasm_bindgen(js_namespace = horizonNet, js_name = close)]
    fn js_close(conn: u32);
    /// Open a connection to the world hosted by room member `peer`: its id.
    #[wasm_bindgen(js_namespace = horizonNet, js_name = open)]
    fn js_open(peer: &str) -> u32;
    /// Announce this page's world in the room (`motd`), or stop (empty).
    #[wasm_bindgen(js_namespace = horizonNet, js_name = hosting)]
    fn js_hosting(motd: &str);
    /// The worlds hosted in the room: `motd\taddress` lines.
    #[wasm_bindgen(js_namespace = horizonNet, js_name = games)]
    fn js_games() -> String;
}

/// The page's ends of the open connections.
static CONNECTIONS: Mutex<Vec<(u32, Pipe)>> = Mutex::new(Vec::new());
/// The world this page hosts, while it accepts players.
static HOST: Mutex<Option<Arc<Shared>>> = Mutex::new(None);

/// The scheme of a WebSim room member's world address.
pub const SCHEME: &str = "websim:";

/// Guest: a connection to the world `peer` hosts; the game's end of the pipe.
pub fn connect(peer: &str) -> Pipe {
    let (game, page) = Pipe::pair();
    let conn = js_open(peer);
    CONNECTIONS.lock().unwrap().push((conn, page));
    game
}

/// Host: accept the room's players into `shared`'s world, announced as `motd`.
pub fn host(shared: Arc<Shared>, motd: &str) {
    *HOST.lock().unwrap() = Some(shared);
    js_hosting(motd);
}

/// Host: stop accepting (players already in stay).
pub fn stop_hosting() {
    if HOST.lock().unwrap().take().is_some() {
        js_hosting("");
    }
}

/// The worlds hosted in the room, for the Multiplayer screen's LAN list.
pub fn games() -> Vec<crate::lan::discovery::LanGame> {
    js_games()
        .lines()
        .filter_map(|line| {
            let (motd, address) = line.split_once('\t')?;
            Some(crate::lan::discovery::LanGame {
                motd: motd.to_owned(),
                address: address.to_owned(),
            })
        })
        .collect()
}

/// A guest asks to join: serve it like an accepted socket. Whether this page
/// hosts a world to join.
#[wasm_bindgen]
pub fn horizon_net_accept(conn: u32) -> bool {
    let Some(shared) = HOST.lock().unwrap().clone() else {
        return false;
    };
    let (server, page) = Pipe::pair();
    CONNECTIONS.lock().unwrap().push((conn, page));
    // Each guest its own private address, as each socket has one.
    let address = std::net::SocketAddr::from(([10, (conn >> 16) as u8, (conn >> 8) as u8, conn as u8], 25565));
    let spawned = std::thread::Builder::new()
        .name("horizon-lan-conn".into())
        .spawn(move || {
            if let Err(e) = crate::lan::conn::serve_pipe(server, address, shared) {
                log::info!("Horizon: a WebSim player left: {e}");
            }
        });
    spawned.is_ok()
}

/// Bytes from the room for connection `conn`.
#[wasm_bindgen]
pub fn horizon_net_deliver(conn: u32, data: &[u8]) {
    let mut connections = CONNECTIONS.lock().unwrap();
    if let Some((_, pipe)) = connections.iter_mut().find(|(id, _)| *id == conn)
        && pipe.write_all(data).is_err()
    {
        connections.retain(|(id, _)| *id != conn);
        drop(connections);
        js_close(conn);
    }
}

/// Connection `conn`'s other end closed.
#[wasm_bindgen]
pub fn horizon_net_closed(conn: u32) {
    let mut connections = CONNECTIONS.lock().unwrap();
    if let Some(i) = connections.iter().position(|(id, _)| *id == conn) {
        let (_, pipe) = connections.remove(i);
        pipe.shutdown();
    }
}

/// Hand what the game wrote to the room; report connections the game closed.
#[wasm_bindgen]
pub fn horizon_net_pump() {
    let mut out = Vec::new();
    let mut closed = Vec::new();
    {
        let connections = CONNECTIONS.lock().unwrap();
        for (conn, pipe) in connections.iter() {
            match pipe.try_read() {
                Some(bytes) if !bytes.is_empty() => out.push((*conn, bytes)),
                Some(_) => {}
                None => closed.push(*conn),
            }
        }
    }
    for (conn, bytes) in out {
        js_send(conn, &bytes);
    }
    if !closed.is_empty() {
        CONNECTIONS
            .lock()
            .unwrap()
            .retain(|(id, _)| !closed.contains(id));
        for conn in closed {
            js_close(conn);
        }
    }
}
