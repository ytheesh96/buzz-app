//! SSH machines: set up buzz-host on a remote computer over the system `ssh`,
//! then keep a local port forward to its token listener.
//!
//! Everything runs through the user's own `ssh`/`scp`, so `~/.ssh/config`,
//! the ssh-agent, ProxyJump and ControlMaster apply. Commands run with
//! `BatchMode=yes`: Buzz never answers password or host-key prompts, so a
//! host must already work from a terminal without one.
//!
//! Setup prints the `buzz-host up --json` contract (`{version,url,token}`).
//! The tunnel is one `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remote>` per
//! machine, restarted with capped, jittered backoff whenever it exits.
//! Agents keep running on the remote while it is down; only control traffic
//! (the token-gated WebSocket) goes through it.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{Ipv4Addr, TcpListener as StdTcpListener};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt as _, AsyncRead, AsyncWriteExt as _, BufReader};
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio::sync::watch;

const MAX_TARGET_LEN: usize = 255;
const MAX_LINE_LEN: usize = 2048;
const MAX_HOSTS: usize = 256;
const SETUP_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const OPEN_WAIT: Duration = Duration::from_secs(25);
const BACKOFF_START: Duration = Duration::from_secs(1);
const BACKOFF_CAP: Duration = Duration::from_secs(30);
/// Where setup uploads a release before installing it, relative to the
/// remote home directory.
const REMOTE_STAGING: &str = ".cache/buzz-host-install";
/// Options every ssh/scp call gets: no prompts, and no `RemoteCommand` or
/// TTY from the user's config, which would conflict with our commands.
const COMMON_OPTIONS: &[&str] = &[
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
];
const COMMAND_OPTIONS: &[&str] = &["-T", "-o", "RemoteCommand=none", "-o", "RequestTTY=no"];

/// Reports the remote OS/CPU and any installed buzz-host.
const PROBE_SCRIPT: &str = r#"
bh=""
for c in "$HOME/.local/bin/buzz-host" "$(command -v buzz-host 2>/dev/null || true)"; do
  if [ -n "$c" ] && [ -x "$c" ]; then bh="$c"; break; fi
done
v=""
if [ -n "$bh" ]; then
  v="$(cat "$HOME/.local/share/buzz-host/runtime/current/VERSION" 2>/dev/null || echo unknown)"
fi
printf 'os=%s\ncpu=%s\nbin=%s\nversion=%s\n' "$(uname -s)" "$(uname -m)" "$bh" "$v"
"#;

/// Installs the staged release (`$1` = asset name), then runs `up --json`.
const INSTALL_SCRIPT: &str = r#"
set -e
d="$HOME/.cache/buzz-host-install"
trap 'rm -rf "$d"' EXIT
sh "$d/install.sh" --bundle "$d/$1" --up --json </dev/null
"#;

/// Runs `up --json` with the installed buzz-host.
const UP_SCRIPT: &str = r#"
set -e
bh="$HOME/.local/bin/buzz-host"
[ -x "$bh" ] || bh="$(command -v buzz-host)"
exec "$bh" up --json </dev/null
"#;

/// `user@host`, `host`, `host:port`-free aliases from `~/.ssh/config`, or an
/// IPv6 literal. Never a leading `-`, which ssh would read as an option.
fn validate_target(target: &str) -> Result<(), String> {
    let valid = !target.is_empty()
        && target.len() <= MAX_TARGET_LEN
        && !target.starts_with('-')
        && target.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(b, b'.' | b'-' | b'_' | b'@' | b':' | b'%' | b'[' | b']')
        })
        && target.matches('@').count() <= 1
        && !target.ends_with('@');
    if valid {
        Ok(())
    } else {
        Err("Enter an SSH host from your ~/.ssh/config or user@host.".into())
    }
}

fn validate_machine_id(id: &str) -> Result<(), String> {
    let valid = !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
    if valid {
        Ok(())
    } else {
        Err("Invalid machine id.".into())
    }
}

/// Concrete `Host` aliases from an ssh config, skipping patterns. Follows
/// `Include` lines whose paths resolve inside `base` (globs in the last
/// path component only).
fn config_hosts(path: &Path, base: &Path, depth: u8, hosts: &mut Vec<String>) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    for line in text.lines() {
        let line = line.trim();
        let mut words = line.splitn(2, |c: char| c.is_whitespace() || c == '=');
        let (Some(keyword), Some(rest)) = (words.next(), words.next()) else {
            continue;
        };
        let rest = rest.trim_start_matches(|c: char| c.is_whitespace() || c == '=');
        if keyword.eq_ignore_ascii_case("host") {
            for alias in rest.split_whitespace() {
                let alias = alias.trim_matches('"');
                if hosts.len() < MAX_HOSTS
                    && !alias.contains(['*', '?', '!'])
                    && validate_target(alias).is_ok()
                    && !hosts.iter().any(|known| known == alias)
                {
                    hosts.push(alias.to_owned());
                }
            }
        } else if keyword.eq_ignore_ascii_case("include") && depth < 4 {
            for pattern in rest.split_whitespace() {
                for included in expand_include(pattern.trim_matches('"'), base) {
                    config_hosts(&included, base, depth + 1, hosts);
                }
            }
        }
    }
}

fn expand_include(pattern: &str, base: &Path) -> Vec<PathBuf> {
    let path = if let Some(rest) = pattern.strip_prefix("~/") {
        match dirs::home_dir() {
            Some(home) => home.join(rest),
            None => return Vec::new(),
        }
    } else if Path::new(pattern).is_absolute() {
        PathBuf::from(pattern)
    } else {
        base.join(pattern)
    };
    let (Some(dir), Some(name)) = (path.parent(), path.file_name().and_then(|n| n.to_str())) else {
        return Vec::new();
    };
    if !name.contains(['*', '?']) {
        return vec![path];
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut matches: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|n| glob_match(name, n))
        })
        .map(|entry| entry.path())
        .collect();
    matches.sort();
    matches
}

fn glob_match(pattern: &str, name: &str) -> bool {
    fn go(p: &[u8], n: &[u8]) -> bool {
        match (p.first(), n.first()) {
            (None, None) => true,
            (Some(b'*'), _) => go(&p[1..], n) || (!n.is_empty() && go(p, &n[1..])),
            (Some(b'?'), Some(_)) => go(&p[1..], &n[1..]),
            (Some(a), Some(b)) if a == b => go(&p[1..], &n[1..]),
            _ => false,
        }
    }
    go(pattern.as_bytes(), name.as_bytes())
}

/// The concrete host aliases in `~/.ssh/config`, in file order.
#[tauri::command]
pub fn ssh_config_hosts() -> Vec<String> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let base = home.join(".ssh");
    let mut hosts = Vec::new();
    config_hosts(&base.join("config"), &base, 0, &mut hosts);
    hosts
}

/// `buzz-host up --json`'s stable fields.
#[derive(Deserialize, Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpResult {
    pub version: String,
    pub url: String,
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pubkey: Option<String>,
}

/// Setup's result: the contract plus what setup did.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SetupResult {
    #[serde(flatten)]
    pub up: UpResult,
    /// The version installed before setup, if any.
    pub previous_version: Option<String>,
    pub installed: bool,
    pub platform: String,
    /// The remote port to forward, when `url` is host-local; `None` when
    /// `url` is a public address the app can reach directly.
    pub tunnel_port: Option<u16>,
}

/// The last stdout line that is the `up --json` object.
fn parse_up(stdout: &str) -> Result<UpResult, String> {
    let up = stdout
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<UpResult>(line.trim()).ok())
        .ok_or("buzz-host up did not print its connection details.")?;
    let url_ok = (up.url.starts_with("ws://") || up.url.starts_with("wss://"))
        && up.url.len() <= 2048
        && !up.url.chars().any(|c| c.is_whitespace() || c.is_control());
    let token_ok = up.token.starts_with("bha_")
        && up.token.len() <= 256
        && up.token.bytes().all(|b| b.is_ascii_graphic());
    if !url_ok || !token_ok {
        return Err("buzz-host up printed an invalid URL or token.".into());
    }
    Ok(up)
}

/// The remote's port for a host-local `ws://127.0.0.1:<port>` URL; `None` for
/// any other (public) URL, which needs no tunnel.
fn loopback_port(url: &str) -> Option<u16> {
    let rest = url.strip_prefix("ws://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let (host, port) = authority.rsplit_once(':')?;
    matches!(host, "127.0.0.1" | "localhost" | "[::1]")
        .then(|| port.parse::<u16>().ok())
        .flatten()
        .filter(|port| *port != 0)
}

#[derive(Debug, PartialEq)]
struct Probe {
    os: String,
    cpu: String,
    bin: String,
    version: String,
}

fn parse_probe(stdout: &str) -> Result<Probe, String> {
    let field = |name: &str| {
        stdout
            .lines()
            .find_map(|line| line.strip_prefix(name)?.strip_prefix('='))
            .map(|value| value.trim().to_owned())
            .unwrap_or_default()
    };
    let probe = Probe {
        os: field("os"),
        cpu: field("cpu"),
        bin: field("bin"),
        version: field("version"),
    };
    if probe.os.is_empty() || probe.cpu.is_empty() {
        return Err("Could not read the remote machine's OS.".into());
    }
    Ok(probe)
}

/// install.sh's bundle target for `uname -s`/`uname -m`.
fn bundle_target(os: &str, cpu: &str) -> Result<&'static str, String> {
    match (os, cpu) {
        ("Linux", "x86_64" | "amd64") => Ok("linux-x64"),
        ("Linux", "aarch64" | "arm64") => Ok("linux-arm64"),
        ("Darwin", "arm64" | "aarch64") => Ok("darwin-arm64"),
        _ => Err(format!("buzz-host has no bundle for {os} {cpu}.")),
    }
}

/// The local release files to upload for `target`: install.sh, the bundle
/// and its checksums.
fn release_files(dir: &Path, target: &str) -> Result<(String, Vec<PathBuf>), String> {
    let asset = format!("buzz-host-{target}.tar.gz");
    let bundle = dir.join(&asset);
    let checksums = [dir.join(format!("{asset}.sha256")), dir.join("SHA256SUMS")]
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| format!("{} has no SHA256SUMS or {asset}.sha256.", dir.display()))?;
    let installer = dir.join("install.sh");
    for (path, what) in [(&bundle, asset.as_str()), (&installer, "install.sh")] {
        if !path.is_file() {
            return Err(format!("{} has no {what}.", dir.display()));
        }
    }
    Ok((asset, vec![installer, bundle, checksums]))
}

/// A setup progress event for the page.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SetupProgress {
    Step { step: &'static str },
    Log { line: String },
}

async fn ssh_program() -> (PathBuf, PathBuf) {
    crate::host_command::load_login_shell_environment().await;
    let path = crate::host_command::effective_path();
    (
        crate::host_command::resolve_program("ssh", &path),
        crate::host_command::resolve_program("scp", &path),
    )
}

fn base_command(program: &Path) -> Command {
    let mut command = Command::new(program);
    command
        .envs(
            crate::host_command::login_shell_environment()
                .iter()
                .cloned(),
        )
        .env("PATH", crate::host_command::effective_path())
        .kill_on_drop(true);
    command
}

async fn forward_lines(reader: impl AsyncRead + Unpin, on_line: &(dyn Fn(String) + Sync)) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line: String = line.chars().take(MAX_LINE_LEN).collect();
        if !line.trim().is_empty() {
            on_line(line);
        }
    }
}

/// Runs `command`, feeding `stdin`, streaming stderr lines to `on_log`.
/// Returns stdout; on failure, the last stderr line explains it.
async fn run(
    mut command: Command,
    stdin: &str,
    on_log: &(dyn Fn(String) + Sync),
) -> Result<String, String> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not run ssh: {e}"))?;
    let mut input = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let last_error = Mutex::new(String::new());
    let log = |line: String| {
        *last_error.lock().unwrap() = line.clone();
        on_log(line);
    };
    let write = async {
        if let Some(mut input) = input.take() {
            let _ = input.write_all(stdin.as_bytes()).await;
        }
    };
    let read_out = async {
        let mut out = String::new();
        if let Some(stdout) = stdout {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if out.len() < 64 * 1024 {
                    out.push_str(&line);
                    out.push('\n');
                }
            }
        }
        out
    };
    let read_err = async {
        if let Some(stderr) = stderr {
            forward_lines(stderr, &log).await;
        }
    };
    let ((), out, ()) = tokio::join!(write, read_out, read_err);
    let status = child.wait().await.map_err(|e| format!("ssh failed: {e}"))?;
    if status.success() {
        Ok(out)
    } else {
        let last = last_error.into_inner().unwrap();
        Err(if last.is_empty() {
            format!("ssh exited with {status}.")
        } else {
            last
        })
    }
}

async fn remote_script(
    ssh: &Path,
    target: &str,
    script: &str,
    args: &[&str],
    on_log: &(dyn Fn(String) + Sync),
) -> Result<String, String> {
    let mut command = base_command(ssh);
    command
        .args(COMMON_OPTIONS)
        .args(COMMAND_OPTIONS)
        .arg("--")
        .arg(target)
        .args(["sh", "-s", "--"])
        .args(args);
    run(command, script, on_log).await
}

/// Installs or upgrades buzz-host on `target` (from `release_dir` when
/// given), starts it, and returns its `up --json` contract.
async fn setup(
    (ssh, scp): (&Path, &Path),
    target: &str,
    release_dir: Option<&Path>,
    progress: &(dyn Fn(SetupProgress) + Sync),
) -> Result<SetupResult, String> {
    validate_target(target)?;
    let log = |line: String| progress(SetupProgress::Log { line });

    progress(SetupProgress::Step { step: "connect" });
    let probe = parse_probe(&remote_script(ssh, target, PROBE_SCRIPT, &[], &log).await?)?;
    let platform = match probe.os.as_str() {
        "Linux" => "linux",
        "Darwin" => "darwin",
        other => other,
    }
    .to_owned();
    let previous_version = (!probe.bin.is_empty()).then(|| probe.version.clone());

    let stdout = if let Some(dir) = release_dir {
        let (asset, files) = release_files(dir, bundle_target(&probe.os, &probe.cpu)?)?;
        progress(SetupProgress::Step { step: "upload" });
        remote_script(
            ssh,
            target,
            &format!("mkdir -p \"$HOME/{REMOTE_STAGING}\""),
            &[],
            &log,
        )
        .await?;
        let mut copy = base_command(scp);
        copy.args(["-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "--"])
            .args(&files)
            .arg(format!("{target}:{REMOTE_STAGING}/"));
        run(copy, "", &log).await?;
        progress(SetupProgress::Step { step: "install" });
        remote_script(ssh, target, INSTALL_SCRIPT, &[&asset], &log).await?
    } else if !probe.bin.is_empty() {
        progress(SetupProgress::Step { step: "start" });
        remote_script(ssh, target, UP_SCRIPT, &[], &log).await?
    } else {
        return Err(format!(
            "buzz-host is not installed on {target}. Choose a release folder to install it."
        ));
    };
    let up = parse_up(&stdout)?;
    Ok(SetupResult {
        tunnel_port: loopback_port(&up.url),
        up,
        previous_version,
        installed: release_dir.is_some(),
        platform,
    })
}

#[tauri::command]
pub async fn ssh_machine_setup(
    target: String,
    release_dir: Option<String>,
    on_progress: tauri::ipc::Channel<SetupProgress>,
) -> Result<SetupResult, String> {
    let home = dirs::home_dir();
    let release_dir = release_dir
        .filter(|dir| !dir.trim().is_empty())
        .map(|dir| crate::workspace_folder::expand(dir.trim(), home.as_deref()));
    let progress = |event: SetupProgress| {
        let _ = on_progress.send(event);
    };
    let (ssh, scp) = ssh_program().await;
    tokio::time::timeout(
        SETUP_TIMEOUT,
        setup((&ssh, &scp), &target, release_dir.as_deref(), &progress),
    )
    .await
    .map_err(|_| "Setup timed out.".to_owned())?
}

/// What the page sees about a tunnel.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TunnelState {
    pub machine_id: String,
    pub state: TunnelPhase,
    pub local_port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TunnelPhase {
    Connecting,
    Connected,
    Reconnecting,
}

#[derive(Clone, PartialEq, Debug)]
struct Spec {
    target: String,
    remote_port: u16,
}

type Notify = Arc<dyn Fn(TunnelState) + Send + Sync>;

struct Tunnel {
    spec: Spec,
    state: watch::Receiver<TunnelState>,
    pid: Arc<Mutex<Option<u32>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Tunnel {
    fn stop(self) {
        self.task.abort();
        if let Some(pid) = self.pid.lock().unwrap().take() {
            terminate(pid);
        }
    }
}

#[cfg(unix)]
fn terminate(pid: u32) {
    if let Ok(pid) = libc::pid_t::try_from(pid) {
        // SAFETY: signals only the ssh child this module spawned and still owns.
        unsafe { libc::kill(pid, libc::SIGTERM) };
    }
}

#[cfg(not(unix))]
fn terminate(_pid: u32) {
    // The aborted task drops its child, which `kill_on_drop` kills.
}

fn free_port(preferred: Option<u16>) -> Result<u16, String> {
    if let Some(port) = preferred.filter(|port| *port >= 1024) {
        if StdTcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok() {
            return Ok(port);
        }
    }
    StdTcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .map_err(|e| format!("Could not pick a local port: {e}"))
}

fn jitter(delay: Duration) -> Duration {
    let mut byte = [0u8; 1];
    let _ = getrandom::fill(&mut byte);
    delay + delay.mul_f64(f64::from(byte[0]) / 255.0 / 4.0)
}

async fn wait_listening(port: u16) -> bool {
    let deadline = tokio::time::Instant::now() + READY_TIMEOUT;
    while tokio::time::Instant::now() < deadline {
        if TcpStream::connect((Ipv4Addr::LOCALHOST, port))
            .await
            .is_ok()
        {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    false
}

/// Keeps `ssh -N -L` running for one machine until aborted.
async fn supervise(
    ssh: PathBuf,
    spec: Spec,
    local_port: u16,
    state: watch::Sender<TunnelState>,
    pid: Arc<Mutex<Option<u32>>>,
) {
    let mut backoff = BACKOFF_START;
    let set = |phase: TunnelPhase, error: Option<String>| {
        state.send_modify(|current| {
            current.state = phase;
            current.error = error;
        });
    };
    loop {
        let mut command = base_command(&ssh);
        command
            .args(COMMON_OPTIONS)
            // The tunnel owns its own connection: a ControlMaster would keep
            // the forward after this process exits, and could not report drops.
            .args([
                "-N",
                "-o",
                "ControlPath=none",
                "-o",
                "ExitOnForwardFailure=yes",
            ])
            .arg("-L")
            .arg(format!(
                "127.0.0.1:{local_port}:127.0.0.1:{}",
                spec.remote_port
            ))
            .arg("--")
            .arg(&spec.target)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let error = match command.spawn() {
            Ok(mut child) => {
                *pid.lock().unwrap() = child.id();
                let last = Arc::new(Mutex::new(String::new()));
                let reader = child.stderr.take().map(|stderr| {
                    let last = last.clone();
                    tokio::spawn(async move {
                        forward_lines(stderr, &move |line| *last.lock().unwrap() = line).await;
                    })
                });
                let connected = tokio::select! {
                    ready = wait_listening(local_port) => Some(ready),
                    _ = child.wait() => None,
                };
                match connected {
                    Some(true) => {
                        backoff = BACKOFF_START;
                        set(TunnelPhase::Connected, None);
                    }
                    // Still running but never forwarding (a hung ProxyJump,
                    // say): restart it rather than wait forever.
                    Some(false) => {
                        *last.lock().unwrap() = "Timed out connecting.".into();
                        let _ = child.start_kill();
                    }
                    None => {}
                }
                let status = child.wait().await;
                pid.lock().unwrap().take();
                if let Some(reader) = reader {
                    let _ = reader.await;
                }
                let last = last.lock().unwrap().clone();
                Some(if !last.is_empty() {
                    last
                } else {
                    match status {
                        Ok(status) => format!("ssh exited with {status}."),
                        Err(e) => format!("ssh failed: {e}"),
                    }
                })
            }
            Err(e) => Some(format!("Could not run ssh: {e}")),
        };
        set(TunnelPhase::Reconnecting, error);
        tokio::time::sleep(jitter(backoff)).await;
        backoff = (backoff * 2).min(BACKOFF_CAP);
    }
}

/// Tauri state: one tunnel per SSH machine.
pub struct SshTunnels {
    tunnels: Mutex<HashMap<String, Tunnel>>,
    notify: Mutex<Option<Notify>>,
}

impl Default for SshTunnels {
    fn default() -> Self {
        Self {
            tunnels: Mutex::default(),
            notify: Mutex::default(),
        }
    }
}

impl SshTunnels {
    /// Starts (or keeps) the tunnel for `machine_id` and waits briefly for it
    /// to connect. Returns its current state, including the local port.
    async fn open(
        &self,
        ssh: PathBuf,
        machine_id: &str,
        spec: Spec,
        preferred_port: Option<u16>,
    ) -> Result<TunnelState, String> {
        let mut receiver = {
            let mut tunnels = self.tunnels.lock().unwrap();
            match tunnels.get(machine_id) {
                Some(tunnel) if tunnel.spec == spec => tunnel.state.clone(),
                _ => {
                    if let Some(old) = tunnels.remove(machine_id) {
                        old.stop();
                    }
                    let local_port = free_port(preferred_port)?;
                    let (sender, receiver) = watch::channel(TunnelState {
                        machine_id: machine_id.to_owned(),
                        state: TunnelPhase::Connecting,
                        local_port,
                        error: None,
                    });
                    if let Some(notify) = self.notify.lock().unwrap().clone() {
                        let mut updates = receiver.clone();
                        tokio::spawn(async move {
                            while updates.changed().await.is_ok() {
                                let current = updates.borrow_and_update().clone();
                                notify(current);
                            }
                        });
                    }
                    let pid = Arc::new(Mutex::new(None));
                    let task = tokio::spawn(supervise(
                        ssh,
                        spec.clone(),
                        local_port,
                        sender,
                        pid.clone(),
                    ));
                    tunnels.insert(
                        machine_id.to_owned(),
                        Tunnel {
                            spec,
                            state: receiver.clone(),
                            pid,
                            task,
                        },
                    );
                    receiver
                }
            }
        };
        let _ = tokio::time::timeout(
            OPEN_WAIT,
            receiver.wait_for(|state| state.state != TunnelPhase::Connecting),
        )
        .await;
        let current = receiver.borrow().clone();
        Ok(current)
    }

    fn close(&self, machine_id: &str) {
        if let Some(tunnel) = self.tunnels.lock().unwrap().remove(machine_id) {
            tunnel.stop();
        }
    }

    fn states(&self) -> Vec<TunnelState> {
        self.tunnels
            .lock()
            .unwrap()
            .values()
            .map(|tunnel| tunnel.state.borrow().clone())
            .collect()
    }

    /// Stops every tunnel; called when Buzz exits.
    pub fn stop_all(&self) {
        for (_, tunnel) in self.tunnels.lock().unwrap().drain() {
            tunnel.stop();
        }
    }
}

#[tauri::command]
pub async fn ssh_tunnel_open<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    tunnels: tauri::State<'_, SshTunnels>,
    machine_id: String,
    target: String,
    remote_port: u16,
    local_port: Option<u16>,
) -> Result<TunnelState, String> {
    validate_machine_id(&machine_id)?;
    validate_target(&target)?;
    if remote_port == 0 {
        return Err("Invalid remote port.".into());
    }
    {
        let mut notify = tunnels.notify.lock().unwrap();
        if notify.is_none() {
            use tauri::Emitter as _;
            *notify = Some(Arc::new(move |state: TunnelState| {
                let _ = app.emit_to("main", "ssh-tunnel-state", state);
            }));
        }
    }
    let (ssh, _) = ssh_program().await;
    tunnels
        .open(
            ssh,
            &machine_id,
            Spec {
                target,
                remote_port,
            },
            local_port,
        )
        .await
}

#[tauri::command]
pub fn ssh_tunnel_close(tunnels: tauri::State<'_, SshTunnels>, machine_id: String) {
    tunnels.close(&machine_id);
}

#[tauri::command]
pub fn ssh_tunnel_states(tunnels: tauri::State<'_, SshTunnels>) -> Vec<TunnelState> {
    tunnels.states()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets_cannot_smuggle_options_or_commands() {
        for ok in [
            "m1",
            "yt@m1",
            "host.example.org",
            "user@[::1]",
            "fe80::1%eth0",
            "a_b-c",
        ] {
            assert!(validate_target(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "-oProxyCommand=touch x",
            "-p22",
            "a b",
            "host;id",
            "host$(id)",
            "user@",
            "a@b@c",
            "host\n",
            "host`id`",
            "'host'",
            &"a".repeat(256),
        ] {
            assert!(validate_target(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn reads_concrete_hosts_and_includes() {
        let dir = std::env::temp_dir().join(format!("buzz-ssh-config-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("conf.d")).unwrap();
        std::fs::write(
            dir.join("config"),
            "# comment\nHost m1 omarchy\n  HostName m1.example.org\nHost *.example.org !bad\nHost=eq-host\n  Include conf.d/*.conf\nhost m1\nMatch all\n",
        )
        .unwrap();
        std::fs::write(dir.join("conf.d/a.conf"), "Host work-box\nHost -evil\n").unwrap();
        std::fs::write(dir.join("conf.d/skip.txt"), "Host not-included\n").unwrap();
        let mut hosts = Vec::new();
        config_hosts(&dir.join("config"), &dir, 0, &mut hosts);
        assert_eq!(hosts, ["m1", "omarchy", "eq-host", "work-box"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn parses_the_up_contract_from_the_last_json_line() {
        let out = "noise\n{\"not\":\"it\"}\n{\"version\":\"0.1.0\",\"url\":\"ws://127.0.0.1:8467\",\"token\":\"bha_abc\",\"pubkey\":\"5daa\",\"future\":1}\n";
        assert_eq!(
            parse_up(out).unwrap(),
            UpResult {
                version: "0.1.0".into(),
                url: "ws://127.0.0.1:8467".into(),
                token: "bha_abc".into(),
                pubkey: Some("5daa".into()),
            }
        );
        for bad in [
            "",
            "{\"version\":\"1\",\"url\":\"http://x\",\"token\":\"bha_a\"}",
            "{\"version\":\"1\",\"url\":\"ws://x\",\"token\":\"bhg_guest\"}",
            "{\"version\":\"1\",\"url\":\"ws://x y\",\"token\":\"bha_a\"}",
        ] {
            assert!(parse_up(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn only_host_local_urls_need_a_tunnel() {
        assert_eq!(loopback_port("ws://127.0.0.1:8467"), Some(8467));
        assert_eq!(loopback_port("ws://localhost:18467/"), Some(18467));
        assert_eq!(loopback_port("ws://[::1]:9000"), Some(9000));
        assert_eq!(loopback_port("wss://host.example.org/_buzz-host"), None);
        assert_eq!(loopback_port("ws://10.0.0.2:8467"), None);
        assert_eq!(loopback_port("ws://127.0.0.1"), None);
        assert_eq!(loopback_port("ws://127.0.0.1:0"), None);
    }

    #[test]
    fn maps_probe_output_to_bundle_targets() {
        let probe =
            parse_probe("os=Linux\ncpu=aarch64\nbin=/home/u/.local/bin/buzz-host\nversion=0.1.0\n")
                .unwrap();
        assert_eq!(probe.version, "0.1.0");
        assert_eq!(bundle_target(&probe.os, &probe.cpu), Ok("linux-arm64"));
        assert_eq!(bundle_target("Linux", "x86_64"), Ok("linux-x64"));
        assert_eq!(bundle_target("Darwin", "arm64"), Ok("darwin-arm64"));
        assert!(bundle_target("Darwin", "x86_64").is_err());
        assert!(parse_probe("garbage").is_err());
    }

    #[test]
    fn release_folder_needs_installer_bundle_and_checksums() {
        let dir = std::env::temp_dir().join(format!("buzz-ssh-release-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(release_files(&dir, "linux-arm64").is_err());
        std::fs::write(dir.join("buzz-host-linux-arm64.tar.gz"), "x").unwrap();
        std::fs::write(dir.join("SHA256SUMS"), "x").unwrap();
        assert!(release_files(&dir, "linux-arm64")
            .unwrap_err()
            .contains("install.sh"));
        std::fs::write(dir.join("install.sh"), "x").unwrap();
        let (asset, files) = release_files(&dir, "linux-arm64").unwrap();
        assert_eq!(asset, "buzz-host-linux-arm64.tar.gz");
        assert_eq!(files.len(), 3);
        assert!(release_files(&dir, "linux-x64").is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // E2E-TEMP: manual end-to-end run, not committed.
    #[tokio::test]
    #[ignore]
    async fn e2e_setup_and_tunnel() {
        let env = |k: &str| std::env::var(k).ok();
        let target = env("BUZZ_SSH_E2E_TARGET").unwrap();
        let ssh = PathBuf::from(env("BUZZ_SSH_E2E_SSH").unwrap_or_else(|| "ssh".into()));
        let scp = PathBuf::from(env("BUZZ_SSH_E2E_SCP").unwrap_or_else(|| "scp".into()));
        let release = env("BUZZ_SSH_E2E_RELEASE").map(PathBuf::from);
        let out = PathBuf::from(env("BUZZ_SSH_E2E_OUT").unwrap());
        let progress = |e: SetupProgress| eprintln!("progress: {e:?}");
        let result = setup((&ssh, &scp), &target, release.as_deref(), &progress)
            .await
            .unwrap();
        eprintln!(
            "setup: version={} url={} installed={} previous={:?} platform={} tunnel_port={:?}",
            result.up.version, result.up.url, result.installed, result.previous_version,
            result.platform, result.tunnel_port
        );
        let tunnels = SshTunnels::default();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = seen.clone();
        *tunnels.notify.lock().unwrap() = Some(Arc::new(move |state: TunnelState| {
            eprintln!("tunnel event: {state:?}");
            record.lock().unwrap().push(state.state);
        }));
        let state = tunnels
            .open(
                ssh.clone(),
                "m_e2e",
                Spec { target: target.clone(), remote_port: result.tunnel_port.unwrap() },
                None,
            )
            .await
            .unwrap();
        eprintln!("tunnel open: {state:?}");
        std::fs::write(
            &out,
            format!("PORT={}\nTOKEN={}\n", state.local_port, result.up.token),
        )
        .unwrap();
        let hold = env("BUZZ_SSH_E2E_HOLD_SECS").and_then(|s| s.parse().ok()).unwrap_or(0);
        tokio::time::sleep(Duration::from_secs(hold)).await;
        eprintln!("phases: {:?}", seen.lock().unwrap());
        tunnels.close("m_e2e");
        tokio::time::sleep(Duration::from_secs(1)).await;
        eprintln!("closed; states: {:?}", tunnels.states());
    }

    /// A fake `ssh` that runs the forward with a local TCP relay, so the
    /// supervisor's connect, drop and reconnect run without a network.
    #[cfg(unix)]
    #[tokio::test]
    async fn tunnel_connects_reconnects_and_stops() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = std::env::temp_dir().join(format!("buzz-ssh-fake-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let runs = dir.join("runs");
        let fake = dir.join("ssh");
        // Each run listens on the -L port for 1s (python3 is on CI runners), then exits.
        std::fs::write(
            &fake,
            format!(
                "#!/bin/sh\necho run >> '{}'\nfor a; do case \"$a\" in 127.0.0.1:*:127.0.0.1:*) spec=\"$a\";; esac; done\nport=$(echo \"$spec\" | cut -d: -f2)\nexec python3 -c 'import socket,sys,time; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind((\"127.0.0.1\", int(sys.argv[1]))); s.listen(); time.sleep(1); sys.stderr.write(\"Connection to m1 closed by remote host.\\n\")' \"$port\"\n",
                runs.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();

        let tunnels = SshTunnels::default();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = seen.clone();
        *tunnels.notify.lock().unwrap() = Some(Arc::new(move |state: TunnelState| {
            record.lock().unwrap().push(state.state);
        }));
        let spec = Spec {
            target: "m1".into(),
            remote_port: 8467,
        };
        let state = tunnels
            .open(fake.clone(), "m_test", spec.clone(), None)
            .await
            .unwrap();
        assert_eq!(state.state, TunnelPhase::Connected, "{state:?}");
        let port = state.local_port;
        // Re-opening the same spec keeps the running tunnel.
        let again = tunnels
            .open(fake.clone(), "m_test", spec, None)
            .await
            .unwrap();
        assert_eq!(again.local_port, port);

        // The fake exits after 1s; the supervisor reports it and reconnects.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            let phases = seen.lock().unwrap().clone();
            let reconnected = phases
                .iter()
                .skip_while(|p| **p != TunnelPhase::Reconnecting)
                .any(|p| *p == TunnelPhase::Connected);
            if reconnected {
                break;
            }
            assert!(tokio::time::Instant::now() < deadline, "{phases:?}");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let dropped = tunnels.states();
        assert_eq!(dropped.len(), 1);
        assert_eq!(dropped[0].local_port, port);

        tunnels.close("m_test");
        assert!(tunnels.states().is_empty());
        let count = std::fs::read_to_string(&runs).unwrap().lines().count();
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert_eq!(
            std::fs::read_to_string(&runs).unwrap().lines().count(),
            count,
            "no restarts after close"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
