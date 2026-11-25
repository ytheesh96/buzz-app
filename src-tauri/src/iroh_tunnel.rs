//! Loopback tunnel from the WebView to buzz-host machines over iroh.
//!
//! The WebView can only open `ws://`/`wss://` sockets, so this binds one
//! `127.0.0.1` listener and forwards each accepted socket's HTTP request,
//! with the `/t/<secret>/<machineId>` prefix stripped, onto a QUIC
//! bi-stream of a pooled iroh connection to that machine. The listener only
//! serves requests that carry the per-session secret and a Buzz WebView
//! `Origin`, and only dials endpoint addresses allowed by the local relay
//! policy (mirrors `buzz-mesh-compute`'s `transport_policy`).

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use iroh::endpoint::{presets, Connection};
use iroh::{Endpoint, EndpointAddr, RelayMap, RelayMode, RelayUrl, TransportAddr};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};

/// ALPN buzz-host accepts tunnelled HTTP/WebSocket streams on.
pub const ALPN: &[u8] = b"buzz-host/ws/1";

const RELAYS_ENV: &str = "BUZZ_MESH_IROH_RELAYS";
const MAX_ENDPOINT_ADDR_LEN: usize = 64 * 1024;
const MAX_TRANSPORT_ADDRS: usize = 16;
const MAX_MACHINE_ID_LEN: usize = 128;
const MAX_PATH_LEN: usize = 4096;
const MAX_HEAD_LEN: usize = 16 * 1024;
const HEAD_TIMEOUT: Duration = Duration::from_secs(5);
const DIAL_TIMEOUT: Duration = Duration::from_secs(15);
const ALLOWED_ORIGINS: &[&str] = &[
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:1430",
    "http://127.0.0.1:1430",
];
/// mesh-llm's default public relays, accepted in `Default` mode alongside
/// iroh's production relays, as `transport_policy` does.
const MESH_LLM_DEFAULT_RELAYS: &[&str] = &[
    "https://usw1-2.relay.michaelneale.mesh-llm.iroh.link./",
    "https://aps1-1.relay.michaelneale.mesh-llm.iroh.link./",
    "https://euc1-1.relay.michaelneale.mesh-llm.iroh.link./",
    "https://use1-1.relay.michaelneale.mesh-llm.iroh.link./",
];

/// Locally configured relay policy (`BUZZ_MESH_IROH_RELAYS`).
#[derive(Debug, Clone, PartialEq, Eq)]
enum RelayPolicy {
    Disabled,
    Default,
    Custom(Vec<RelayUrl>),
}

fn relay_policy() -> Result<RelayPolicy, String> {
    relay_policy_from(std::env::var(RELAYS_ENV).ok().as_deref())
}

fn relay_policy_from(raw: Option<&str>) -> Result<RelayPolicy, String> {
    match raw.map(str::trim) {
        Some("0") => Ok(RelayPolicy::Disabled),
        None | Some("") | Some("1") | Some("default") => Ok(RelayPolicy::Default),
        Some(list) => {
            let urls = list
                .split(',')
                .map(str::trim)
                .filter(|url| !url.is_empty())
                .map(parse_configured_relay)
                .collect::<Result<Vec<_>, _>>()?;
            if urls.is_empty() {
                return Err(format!("{RELAYS_ENV} must contain at least one relay URL"));
            }
            Ok(RelayPolicy::Custom(urls))
        }
    }
}

fn parse_configured_relay(raw: &str) -> Result<RelayUrl, String> {
    let parsed = url::Url::parse(raw).map_err(|e| format!("invalid relay URL {raw:?}: {e}"))?;
    let loopback = parsed.host().is_some_and(|host| match host {
        url::Host::Domain(domain) => domain.eq_ignore_ascii_case("localhost"),
        url::Host::Ipv4(ip) => ip.is_loopback(),
        url::Host::Ipv6(ip) => ip.is_loopback(),
    });
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && loopback) {
        return Err(format!(
            "relay URL {raw:?} must use https (http is allowed only for loopback development)"
        ));
    }
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !matches!(parsed.path(), "" | "/")
    {
        return Err(format!(
            "relay URL {raw:?} must be an origin without credentials, path, query, or fragment"
        ));
    }
    raw.parse::<RelayUrl>()
        .map_err(|e| format!("invalid iroh relay URL {raw:?}: {e}"))
}

impl RelayPolicy {
    fn relay_mode(&self) -> RelayMode {
        match self {
            Self::Disabled => RelayMode::Disabled,
            Self::Default => RelayMode::Default,
            Self::Custom(urls) => RelayMode::Custom(urls.iter().cloned().collect::<RelayMap>()),
        }
    }

    fn allows(&self, relay: &RelayUrl) -> bool {
        match self {
            Self::Disabled => false,
            Self::Default => {
                iroh::defaults::prod::default_relay_map().contains(relay)
                    || MESH_LLM_DEFAULT_RELAYS
                        .iter()
                        .any(|known| known.parse::<RelayUrl>().is_ok_and(|k| &k == relay))
            }
            Self::Custom(urls) => urls.contains(relay),
        }
    }
}

/// Decodes an advertised `EndpointAddr` (URL_SAFE_NO_PAD base64 JSON) and
/// keeps only transports this node may dial. Fails when none remain.
fn validate_endpoint_addr(raw: &str, policy: &RelayPolicy) -> Result<EndpointAddr, String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > MAX_ENDPOINT_ADDR_LEN {
        return Err("Iroh endpoint address is empty or too long.".into());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|e| format!("Invalid Iroh endpoint address encoding: {e}"))?;
    let mut addr: EndpointAddr = serde_json::from_slice(&bytes)
        .map_err(|e| format!("Invalid Iroh endpoint address: {e}"))?;
    if addr.addrs.is_empty() || addr.addrs.len() > MAX_TRANSPORT_ADDRS {
        return Err(format!(
            "Iroh endpoint must contain 1..={MAX_TRANSPORT_ADDRS} transport addresses."
        ));
    }
    let mut rejected = Vec::new();
    addr.addrs.retain(|transport| match transport {
        TransportAddr::Relay(relay) if policy.allows(relay) => true,
        TransportAddr::Ip(socket) if dialable_socket(*socket) => true,
        other => {
            rejected.push(format!("{other:?}"));
            false
        }
    });
    if addr.addrs.is_empty() {
        return Err(format!(
            "Iroh endpoint has no usable transport address (rejected: {}).",
            rejected.join(", ")
        ));
    }
    Ok(addr)
}

fn dialable_socket(socket: SocketAddr) -> bool {
    let ip = socket.ip();
    !(socket.port() == 0
        || ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        || match ip {
            IpAddr::V4(ip) => ip.is_link_local() || ip.is_broadcast(),
            IpAddr::V6(ip) => ip.is_unicast_link_local(),
        })
}

fn validate_machine_id(id: &str) -> Result<(), String> {
    let valid = !id.is_empty()
        && id.len() <= MAX_MACHINE_ID_LEN
        && !id.contains("..")
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
    if valid {
        Ok(())
    } else {
        Err("Invalid machine id.".into())
    }
}

fn validate_path(path: &str) -> Result<(), String> {
    let valid = path.is_empty()
        || (path.starts_with('/')
            && path.len() <= MAX_PATH_LEN
            && path.bytes().all(|b| b.is_ascii_graphic() && b != b'#'));
    if valid {
        Ok(())
    } else {
        Err("Tunnel path must be empty or start with / and contain no spaces or control characters.".into())
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

type ConnectionSlot = Arc<tokio::sync::Mutex<Option<Connection>>>;

struct Machine {
    addr: EndpointAddr,
    connection: ConnectionSlot,
}

struct Shared {
    endpoint: Endpoint,
    secret: String,
    machines: Mutex<HashMap<String, Machine>>,
}

/// A running loopback listener and its iroh endpoint.
struct Tunnel {
    shared: Arc<Shared>,
    port: u16,
    accept: tokio::task::JoinHandle<()>,
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.accept.abort();
    }
}

impl Tunnel {
    async fn start(relay_mode: RelayMode) -> Result<Self, String> {
        let endpoint = Endpoint::builder(presets::Minimal)
            .relay_mode(relay_mode)
            .bind()
            .await
            .map_err(|e| format!("Could not start Iroh endpoint: {e}"))?;
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|e| format!("Could not bind Iroh tunnel listener: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("Could not read Iroh tunnel port: {e}"))?
            .port();
        let mut secret = [0u8; 32];
        getrandom::fill(&mut secret).map_err(|e| format!("Could not create tunnel secret: {e}"))?;
        let shared = Arc::new(Shared {
            endpoint,
            secret: secret.iter().map(|b| format!("{b:02x}")).collect(),
            machines: Mutex::default(),
        });
        let accept = tokio::spawn(accept_loop(listener, shared.clone()));
        Ok(Self {
            shared,
            port,
            accept,
        })
    }

    /// Registers `addr` for `machine_id`, dropping a pooled connection to a
    /// different address, and returns the WebView URL for `path`.
    fn route(&self, machine_id: &str, addr: EndpointAddr, path: &str) -> String {
        let mut machines = self.shared.machines.lock().unwrap();
        if machines.get(machine_id).is_none_or(|m| m.addr != addr) {
            if let Some(old) = machines.insert(
                machine_id.to_owned(),
                Machine {
                    addr,
                    connection: ConnectionSlot::default(),
                },
            ) {
                close_slot(&old.connection);
            }
        }
        format!(
            "ws://127.0.0.1:{}/t/{}/{machine_id}{path}",
            self.port, self.shared.secret
        )
    }

    fn disconnect(&self, machine_id: &str) {
        if let Some(old) = self.shared.machines.lock().unwrap().remove(machine_id) {
            close_slot(&old.connection);
        }
    }
}

fn close_slot(slot: &ConnectionSlot) {
    if let Ok(mut slot) = slot.try_lock() {
        if let Some(conn) = slot.take() {
            conn.close(0u32.into(), b"route changed");
        }
    }
    // A dial in progress keeps its slot; the slot is unreachable once removed.
}

async fn accept_loop(listener: TcpListener, shared: Arc<Shared>) {
    loop {
        match listener.accept().await {
            Ok((socket, _)) => {
                tokio::spawn(serve(socket, shared.clone()));
            }
            Err(error) => {
                eprintln!("Iroh tunnel accept failed: {error}");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

async fn respond(socket: &mut TcpStream, status: &str, message: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{message}",
        message.len()
    );
    let _ = socket.write_all(response.as_bytes()).await;
    let _ = socket.shutdown().await;
}

/// Reads the HTTP request head; returns it and any bytes read past it.
async fn read_head(socket: &mut TcpStream) -> Option<(String, Vec<u8>)> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0u8; 2048];
    loop {
        let read = socket.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            let rest = buffer.split_off(end + 4);
            return Some((String::from_utf8(buffer).ok()?, rest));
        }
        if buffer.len() > MAX_HEAD_LEN {
            return None;
        }
    }
}

enum Rejection {
    BadRequest,
    Forbidden,
    NotFound,
}

/// Checks the request and returns the machine and the head rewritten for it.
fn authorize(shared: &Shared, head: &str) -> Result<(String, String), Rejection> {
    let (request_line, headers) = head.split_once("\r\n").ok_or(Rejection::BadRequest)?;
    let mut parts = request_line.split(' ');
    let (Some(method), Some(target), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(Rejection::BadRequest);
    };
    let origin = headers.split("\r\n").find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("origin")
            .then(|| value.trim())
    });
    if !origin.is_some_and(|origin| ALLOWED_ORIGINS.contains(&origin)) {
        return Err(Rejection::Forbidden);
    }
    let routed = target.strip_prefix("/t/").ok_or(Rejection::Forbidden)?;
    let (secret, routed) = routed.split_once('/').ok_or(Rejection::Forbidden)?;
    if !constant_time_eq(secret.as_bytes(), shared.secret.as_bytes()) {
        return Err(Rejection::Forbidden);
    }
    let split = routed.find(['/', '?']).unwrap_or(routed.len());
    let (machine_id, rest) = routed.split_at(split);
    if !shared.machines.lock().unwrap().contains_key(machine_id) {
        return Err(Rejection::NotFound);
    }
    let rest = match rest {
        "" => "/".to_owned(),
        query if query.starts_with('?') => format!("/{query}"),
        path => path.to_owned(),
    };
    Ok((
        machine_id.to_owned(),
        format!("{method} {rest} {version}\r\n{headers}"),
    ))
}

async fn serve(mut socket: TcpStream, shared: Arc<Shared>) {
    let Ok(Some((head, body))) = tokio::time::timeout(HEAD_TIMEOUT, read_head(&mut socket)).await
    else {
        return respond(&mut socket, "400 Bad Request", "Bad request").await;
    };
    let (machine_id, head) = match authorize(&shared, &head) {
        Ok(routed) => routed,
        Err(Rejection::BadRequest) => {
            return respond(&mut socket, "400 Bad Request", "Bad request").await
        }
        Err(Rejection::Forbidden) => {
            return respond(&mut socket, "403 Forbidden", "Forbidden").await
        }
        Err(Rejection::NotFound) => {
            return respond(&mut socket, "404 Not Found", "Unknown machine").await
        }
    };
    let (mut send, recv) = match open_stream(&shared, &machine_id).await {
        Ok(stream) => stream,
        Err(error) => return respond(&mut socket, "502 Bad Gateway", &error).await,
    };
    if send.write_all(head.as_bytes()).await.is_err() || send.write_all(&body).await.is_err() {
        return respond(&mut socket, "502 Bad Gateway", "Iroh stream closed").await;
    }
    let mut remote = tokio::io::join(recv, send);
    let _ = tokio::io::copy_bidirectional(&mut socket, &mut remote).await;
}

/// Opens a bi-stream on the machine's pooled connection, dialing (once more
/// if the pooled connection turns out to be dead) as needed.
async fn open_stream(
    shared: &Shared,
    machine_id: &str,
) -> Result<(iroh::endpoint::SendStream, iroh::endpoint::RecvStream), String> {
    let (addr, slot) = {
        let machines = shared.machines.lock().unwrap();
        let machine = machines.get(machine_id).ok_or("Unknown machine")?;
        (machine.addr.clone(), machine.connection.clone())
    };
    let mut slot = slot.lock().await;
    for _ in 0..2 {
        let conn = match slot.as_ref().filter(|c| c.close_reason().is_none()) {
            Some(conn) => conn.clone(),
            None => {
                let conn =
                    tokio::time::timeout(DIAL_TIMEOUT, shared.endpoint.connect(addr.clone(), ALPN))
                        .await
                        .map_err(|_| "Timed out connecting over Iroh".to_owned())?
                        .map_err(|e| format!("Could not connect over Iroh: {e}"))?;
                slot.insert(conn).clone()
            }
        };
        match conn.open_bi().await {
            Ok(stream) => return Ok(stream),
            Err(_) => *slot = None,
        }
    }
    Err("Could not open an Iroh stream".into())
}

/// Tauri state: the tunnel starts on first use.
#[derive(Default)]
pub struct IrohTunnelManager {
    tunnel: tokio::sync::OnceCell<Tunnel>,
}

impl IrohTunnelManager {
    async fn endpoint_url(
        &self,
        machine_id: &str,
        endpoint_addr: &str,
        path: &str,
    ) -> Result<String, String> {
        validate_machine_id(machine_id)?;
        validate_path(path)?;
        let policy = relay_policy()?;
        let addr = validate_endpoint_addr(endpoint_addr, &policy)?;
        let tunnel = self
            .tunnel
            .get_or_try_init(|| Tunnel::start(policy.relay_mode()))
            .await?;
        Ok(tunnel.route(machine_id, addr, path))
    }
}

#[tauri::command]
pub fn iroh_tunnel_available() -> bool {
    relay_policy().is_ok()
}

#[tauri::command]
pub async fn iroh_tunnel_endpoint(
    tunnel: tauri::State<'_, IrohTunnelManager>,
    machine_id: String,
    endpoint_addr: String,
    path: Option<String>,
) -> Result<String, String> {
    tunnel
        .endpoint_url(&machine_id, &endpoint_addr, path.as_deref().unwrap_or(""))
        .await
}

#[tauri::command]
pub fn iroh_tunnel_disconnect(
    tunnel: tauri::State<'_, IrohTunnelManager>,
    machine_id: String,
) -> Result<(), String> {
    validate_machine_id(&machine_id)?;
    if let Some(tunnel) = tunnel.tunnel.get() {
        tunnel.disconnect(&machine_id);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(addr: &EndpointAddr) -> String {
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(addr).unwrap())
    }

    fn addr_with(transports: impl IntoIterator<Item = TransportAddr>) -> EndpointAddr {
        let mut addr = EndpointAddr::new(iroh::SecretKey::generate().public());
        addr.addrs.extend(transports);
        addr
    }

    #[test]
    fn relay_policy_parses_the_environment_contract() {
        assert_eq!(relay_policy_from(Some("0")), Ok(RelayPolicy::Disabled));
        for default in [None, Some(""), Some("1"), Some("default")] {
            assert_eq!(relay_policy_from(default), Ok(RelayPolicy::Default));
        }
        assert!(matches!(
            relay_policy_from(Some("https://relay.example.org")),
            Ok(RelayPolicy::Custom(urls)) if urls.len() == 1
        ));
        assert!(relay_policy_from(Some("http://127.0.0.1:3340")).is_ok());
        for invalid in [
            "http://relay.example.org",
            "https://user@relay.example.org",
            "https://relay.example.org/path",
            "https://relay.example.org?token=secret",
            ",",
        ] {
            assert!(relay_policy_from(Some(invalid)).is_err(), "{invalid}");
        }
    }

    #[test]
    fn endpoint_addr_must_use_policy_approved_transports() {
        let allowed: RelayUrl = "https://relay.example.org".parse().unwrap();
        let untrusted: RelayUrl = "https://evil.example.org".parse().unwrap();
        let custom = RelayPolicy::Custom(vec![allowed.clone()]);

        let relay_only = encode(&addr_with([TransportAddr::Relay(allowed.clone())]));
        assert!(validate_endpoint_addr(&relay_only, &custom).is_ok());
        assert!(validate_endpoint_addr(&relay_only, &RelayPolicy::Disabled).is_err());
        assert!(validate_endpoint_addr(&relay_only, &RelayPolicy::Default).is_err());

        let untrusted_only = encode(&addr_with([TransportAddr::Relay(untrusted.clone())]));
        assert!(validate_endpoint_addr(&untrusted_only, &custom).is_err());

        let direct = encode(&addr_with([TransportAddr::Ip(
            "192.168.1.20:47916".parse().unwrap(),
        )]));
        assert!(validate_endpoint_addr(&direct, &RelayPolicy::Disabled).is_ok());

        let mixed = addr_with([
            TransportAddr::Relay(untrusted),
            TransportAddr::Ip("192.168.1.20:47916".parse().unwrap()),
            TransportAddr::Ip("127.0.0.1:47916".parse().unwrap()),
            TransportAddr::Ip("169.254.169.254:80".parse().unwrap()),
        ]);
        let sanitized = validate_endpoint_addr(&encode(&mixed), &custom).unwrap();
        assert_eq!(sanitized.id, mixed.id);
        assert_eq!(
            sanitized.addrs.into_iter().collect::<Vec<_>>(),
            [TransportAddr::Ip("192.168.1.20:47916".parse().unwrap())]
        );

        let mesh_default: RelayUrl = MESH_LLM_DEFAULT_RELAYS[0].parse().unwrap();
        let mesh = encode(&addr_with([TransportAddr::Relay(mesh_default)]));
        assert!(validate_endpoint_addr(&mesh, &RelayPolicy::Default).is_ok());

        for junk in [
            "",
            "not base64!",
            "e30",
            &"a".repeat(MAX_ENDPOINT_ADDR_LEN + 1),
        ] {
            assert!(validate_endpoint_addr(junk, &RelayPolicy::Default).is_err());
        }
    }

    #[test]
    fn machine_ids_and_paths_cannot_escape_the_route() {
        for ok in [
            "default",
            "m_1a2b3c4d",
            "3f2a9c1e-0b7d-4e55-9a1c-2d3e4f5a6b7c",
            "omarchy.tail",
        ] {
            assert!(validate_machine_id(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "a/b",
            "..",
            "a..b",
            "has space",
            "tab\t",
            "ünï",
            &"a".repeat(129),
        ] {
            assert!(validate_machine_id(bad).is_err(), "{bad}");
        }
        for ok in ["", "/", "/desktop?ticket=abc"] {
            assert!(validate_path(ok).is_ok(), "{ok}");
        }
        for bad in ["desktop", "/a b", "/a\r\nX: y", "/a#frag"] {
            assert!(validate_path(bad).is_err(), "{bad}");
        }
    }

    async fn request(port: u16, head: &str) -> String {
        let mut socket = TcpStream::connect((Ipv4Addr::LOCALHOST, port))
            .await
            .unwrap();
        socket.write_all(head.as_bytes()).await.unwrap();
        let mut response = String::new();
        socket.read_to_string(&mut response).await.unwrap();
        response
    }

    fn upgrade(target: &str, origin: Option<&str>) -> String {
        let origin = origin
            .map(|o| format!("Origin: {o}\r\n"))
            .unwrap_or_default();
        format!(
            "GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n{origin}Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
    }

    #[tokio::test]
    async fn loopback_requires_origin_secret_and_known_machine() {
        let tunnel = Tunnel::start(RelayMode::Disabled).await.unwrap();
        let addr = addr_with([TransportAddr::Ip("192.0.2.1:9".parse().unwrap())]);
        let url = tunnel.route("known", addr, "");
        let target = url
            .strip_prefix(&format!("ws://127.0.0.1:{}", tunnel.port))
            .unwrap();
        let secret = &tunnel.shared.secret;
        assert_eq!(secret.len(), 64);

        let bad_secret = format!("/t/{}/known", "0".repeat(64));
        let response = request(
            tunnel.port,
            &upgrade(&bad_secret, Some("tauri://localhost")),
        )
        .await;
        assert!(response.starts_with("HTTP/1.1 403"), "{response}");

        for origin in [Some("https://evil.example.org"), None] {
            let response = request(tunnel.port, &upgrade(target, origin)).await;
            assert!(response.starts_with("HTTP/1.1 403"), "{response}");
        }

        let unknown = format!("/t/{secret}/unknown/desktop");
        let response = request(
            tunnel.port,
            &upgrade(&unknown, Some("http://tauri.localhost")),
        )
        .await;
        assert!(response.starts_with("HTTP/1.1 404"), "{response}");

        let response = request(tunnel.port, "garbage\r\n\r\n").await;
        assert!(response.starts_with("HTTP/1.1 400"), "{response}");

        tunnel.disconnect("known");
        let response = request(tunnel.port, &upgrade(target, Some("tauri://localhost"))).await;
        assert!(response.starts_with("HTTP/1.1 404"), "{response}");
    }

    /// A buzz-host stand-in: accepts `ALPN` streams and pipes each to a local
    /// TCP server, as buzz-host forwards to its WebSocket listener.
    async fn spawn_host(backend: SocketAddr) -> (Endpoint, EndpointAddr) {
        let host = Endpoint::builder(presets::Minimal)
            .relay_mode(RelayMode::Disabled)
            .clear_ip_transports()
            .bind_addr((Ipv4Addr::LOCALHOST, 0))
            .unwrap()
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .unwrap();
        let mut addr = EndpointAddr::new(host.id());
        addr.addrs
            .extend(host.bound_sockets().into_iter().map(TransportAddr::Ip));
        let accepting = host.clone();
        tokio::spawn(async move {
            while let Some(incoming) = accepting.accept().await {
                let Ok(conn) = incoming.await else { continue };
                tokio::spawn(async move {
                    while let Ok((send, recv)) = conn.accept_bi().await {
                        tokio::spawn(async move {
                            let mut tcp = TcpStream::connect(backend).await.unwrap();
                            let mut stream = tokio::io::join(recv, send);
                            let _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await;
                        });
                    }
                });
            }
        });
        (host, addr)
    }

    #[tokio::test]
    async fn tunnels_rewritten_requests_and_bytes_both_ways() {
        // Backend: reports the request head it saw, then echoes.
        let backend = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let backend_addr = backend.local_addr().unwrap();
        let (head_seen, head_rx) = tokio::sync::oneshot::channel::<String>();
        tokio::spawn(async move {
            let (mut socket, _) = backend.accept().await.unwrap();
            let (head, rest) = read_head(&mut socket).await.unwrap();
            head_seen.send(head).unwrap();
            socket
                .write_all(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
                .await
                .unwrap();
            socket.write_all(&rest).await.unwrap();
            let (mut read, mut write) = socket.split();
            tokio::io::copy(&mut read, &mut write).await.unwrap();
        });
        let (host, host_addr) = spawn_host(backend_addr).await;

        let tunnel = Tunnel::start(RelayMode::Disabled).await.unwrap();
        // Loopback addresses are rejected for advertised endpoints, so the test
        // registers its validated-equivalent address directly.
        let url = tunnel.route("m_test", host_addr, "/desktop?ticket=abc");
        let target = url
            .strip_prefix(&format!("ws://127.0.0.1:{}", tunnel.port))
            .unwrap();
        assert!(target.starts_with(&format!("/t/{}/m_test/", tunnel.shared.secret)));

        let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, tunnel.port))
            .await
            .unwrap();
        let mut head = upgrade(target, Some("tauri://localhost"));
        head.push_str("early");
        client.write_all(head.as_bytes()).await.unwrap();

        let seen = tokio::time::timeout(Duration::from_secs(10), head_rx)
            .await
            .unwrap()
            .unwrap();
        assert!(
            seen.starts_with("GET /desktop?ticket=abc HTTP/1.1\r\n"),
            "{seen}"
        );
        assert!(seen.contains("\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"));
        assert!(seen.contains("\r\nOrigin: tauri://localhost\r\n"));
        assert!(!seen.contains(&tunnel.shared.secret));

        let expected = b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nearly";
        let mut received = vec![0u8; expected.len()];
        client.read_exact(&mut received).await.unwrap();
        assert_eq!(received, expected);

        client.write_all(b"ping over iroh").await.unwrap();
        let mut echoed = [0u8; 14];
        tokio::time::timeout(Duration::from_secs(10), client.read_exact(&mut echoed))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&echoed, b"ping over iroh");

        // The connection stays pooled for the machine's next socket.
        let pooled = tunnel.shared.machines.lock().unwrap()["m_test"]
            .connection
            .clone();
        assert!(pooled.lock().await.is_some());
        host.close().await;
    }
}
