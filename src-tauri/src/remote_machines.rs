//! buzz-host machine presence: kind 30003 events a machine key publishes,
//! attested (NIP-OA) by and NIP-44 encrypted to the signed-in human. Fail
//! closed per event: anything not fully verified is dropped from the batch.
use crate::identity::IdentityHost;
use nostr::event::Event;
use secp256k1::{schnorr::Signature, Secp256k1, XOnlyPublicKey};
use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};

const STATUS_KIND: u16 = 30003;
const STATUS_TOPIC: &str = "buzz-host-status";
const COORDINATE_PREFIX: &str = "buzz-host:";
const MAX_EVENTS: usize = 64;
const MAX_TEXT: usize = 256;
const MAX_URL: usize = 2048;
const MAX_ENDPOINT_ADDR: usize = 8192;
const MAX_ROUTES: usize = 16;
const MAX_RUNTIMES: usize = 16;
const MAX_AGENTS: usize = 256;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedRemoteMachineStatus {
    pub event_id: String,
    /// The machine key that signed the event.
    pub pubkey: String,
    pub created_at: u64,
    pub payload: StatusPayload,
}

#[derive(Deserialize, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatusPayload {
    pub v: u8,
    pub status: MachineState,
    pub machine_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    #[serde(default)]
    pub runtimes: Vec<String>,
    #[serde(default)]
    pub capabilities: Capabilities,
    #[serde(default, deserialize_with = "known_routes")]
    pub routes: Vec<Route>,
    #[serde(default)]
    pub agents: Vec<AgentEntry>,
    #[serde(default)]
    pub public_guest_url: Option<String>,
    pub updated_at: u64,
}

#[derive(Deserialize, Serialize, Debug, PartialEq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum MachineState {
    Online,
    Stopped,
}

#[derive(Deserialize, Serialize, Debug, PartialEq, Default)]
pub struct Capabilities {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub docker: Option<bool>,
}

#[derive(Deserialize, Serialize, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Route {
    Wss {
        url: String,
    },
    Iroh {
        #[serde(rename = "nodeId")]
        node_id: String,
        #[serde(
            rename = "endpointAddr",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        endpoint_addr: Option<String>,
    },
}

#[derive(Deserialize, Serialize, Debug, PartialEq)]
pub struct AgentEntry {
    pub pubkey: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Route types this app does not know yet are skipped; a known one must parse.
fn known_routes<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<Route>, D::Error> {
    Vec::<serde_json::Value>::deserialize(deserializer)?
        .into_iter()
        .filter(|route| matches!(route["type"].as_str(), Some("wss" | "iroh")))
        .map(|route| serde_json::from_value(route).map_err(serde::de::Error::custom))
        .collect()
}

/// An authenticated event whose content is still encrypted.
struct Candidate {
    id: String,
    pubkey: String,
    created_at: u64,
    content: String,
    machine_id: String,
}

fn lower_hex(text: &str, len: usize) -> bool {
    text.len() == len
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn text_ok(text: &str) -> bool {
    !text.trim().is_empty() && text.len() <= MAX_TEXT && !text.chars().any(char::is_control)
}

fn wss_ok(url: &str) -> bool {
    url.len() <= MAX_URL
        && url.len() > "wss://".len()
        && url.starts_with("wss://")
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

fn machine_id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.contains("..")
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// NIP-OA: `owner` signed sha256("nostr:agent-auth:<agent>:") with BIP-340.
fn owner_attests(owner: &str, signature: &str, agent: &str) -> bool {
    let (Ok(owner), Ok(signature)) = (
        owner.parse::<XOnlyPublicKey>(),
        signature.parse::<Signature>(),
    ) else {
        return false;
    };
    let digest = Sha256::digest(format!("nostr:agent-auth:{agent}:"));
    Secp256k1::verification_only()
        .verify_schnorr(&signature, &digest, &owner)
        .is_ok()
}

/// Everything about the event except its encrypted content.
fn authenticate(raw: &serde_json::Value, viewer: &str) -> Option<Candidate> {
    let tags: Vec<Vec<String>> = serde_json::from_value(raw.get("tags")?.clone()).ok()?;
    let event: Event = serde_json::from_value(raw.clone()).ok()?;
    // NIP-01 id and BIP-340 signature over exactly these tags and content.
    event.verify().ok()?;
    if event.kind.as_u16() != STATUS_KIND {
        return None;
    }
    let pubkey = event.pubkey.to_hex();
    let named = |name: &'static str| {
        tags.iter()
            .filter(move |tag| tag.first().map(String::as_str) == Some(name))
    };
    let [d] = named("d").collect::<Vec<_>>()[..] else {
        return None;
    };
    let machine_id = d.get(1)?.strip_prefix(COORDINATE_PREFIX)?;
    if !machine_id_ok(machine_id)
        || !named("k").any(|tag| tag.get(1).map(String::as_str) == Some(STATUS_TOPIC))
        || !named("p").any(|tag| tag.get(1).map(String::as_str) == Some(viewer))
    {
        return None;
    }
    let [auth] = named("auth").collect::<Vec<_>>()[..] else {
        return None;
    };
    let [_, owner, condition, signature] = &auth[..] else {
        return None;
    };
    if owner != viewer || !condition.is_empty() || !owner_attests(owner, signature, &pubkey) {
        return None;
    }
    Some(Candidate {
        id: event.id.to_hex(),
        pubkey,
        created_at: event.created_at.as_secs(),
        content: event.content,
        machine_id: machine_id.to_owned(),
    })
}

fn parse_payload(plaintext: &str, machine_id: &str) -> Option<StatusPayload> {
    let payload: StatusPayload = serde_json::from_str(plaintext).ok()?;
    let optional_text = |value: &Option<String>| value.as_deref().is_none_or(text_ok);
    let valid = payload.v == 1
        && payload.machine_id == machine_id
        && text_ok(&payload.name)
        && optional_text(&payload.host)
        && optional_text(&payload.platform)
        && payload.runtimes.len() <= MAX_RUNTIMES
        && payload.runtimes.iter().all(|runtime| text_ok(runtime))
        && payload.routes.len() <= MAX_ROUTES
        && payload.routes.iter().all(|route| match route {
            Route::Wss { url } => wss_ok(url),
            Route::Iroh {
                node_id,
                endpoint_addr,
            } => {
                !node_id.is_empty()
                    && node_id.len() <= 128
                    && node_id.bytes().all(|b| b.is_ascii_alphanumeric())
                    && endpoint_addr.as_deref().is_none_or(|addr| {
                        !addr.is_empty()
                            && addr.len() <= MAX_ENDPOINT_ADDR
                            && addr
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
                    })
            }
        })
        && payload.agents.len() <= MAX_AGENTS
        && payload.agents.iter().all(|agent| {
            lower_hex(&agent.pubkey, 64)
                && agent
                    .name
                    .as_deref()
                    .is_none_or(|name| name.is_empty() || text_ok(name))
        })
        && payload.public_guest_url.as_deref().is_none_or(wss_ok);
    valid.then_some(payload)
}

pub(crate) async fn verify_statuses(
    host: &IdentityHost,
    events: Vec<serde_json::Value>,
) -> Result<Vec<VerifiedRemoteMachineStatus>, String> {
    let viewer = host.viewer().await?;
    let mut verified = Vec::new();
    for raw in events.iter().take(MAX_EVENTS) {
        let Some(candidate) = authenticate(raw, &viewer) else {
            continue;
        };
        let Ok(plaintext) = host
            .decrypt_from_peer(&candidate.pubkey, &candidate.content)
            .await
        else {
            continue;
        };
        let Some(payload) = parse_payload(&plaintext, &candidate.machine_id) else {
            continue;
        };
        verified.push(VerifiedRemoteMachineStatus {
            event_id: candidate.id,
            pubkey: candidate.pubkey,
            created_at: candidate.created_at,
            payload,
        });
    }
    Ok(verified)
}

/// Verified, decrypted machine statuses from a batch of candidate relay events.
#[tauri::command]
pub async fn remote_machine_decrypt_statuses(
    host: tauri::State<'_, IdentityHost>,
    events: Vec<serde_json::Value>,
) -> Result<Vec<VerifiedRemoteMachineStatus>, String> {
    verify_statuses(host.inner(), events).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{
        key::{PublicKey, SecretKey},
        nips::nip44,
    };
    use secp256k1::Keypair;
    use serde_json::json;

    const VIEWER: [u8; 32] = [1; 32];
    const MACHINE: [u8; 32] = [3; 32];
    const STRANGER: [u8; 32] = [5; 32];

    fn pair(secret: [u8; 32]) -> Keypair {
        Keypair::from_secret_key(
            &Secp256k1::signing_only(),
            &secp256k1::SecretKey::from_byte_array(secret).unwrap(),
        )
    }
    fn hex_of(secret: [u8; 32]) -> String {
        pair(secret).x_only_public_key().0.to_string()
    }
    fn schnorr(secret: [u8; 32], digest: &[u8]) -> String {
        Secp256k1::signing_only()
            .sign_schnorr_no_aux_rand(digest, &pair(secret))
            .to_string()
    }
    fn auth(signer: [u8; 32], owner: &str, agent: &str) -> Vec<String> {
        let digest = Sha256::digest(format!("nostr:agent-auth:{agent}:"));
        vec![
            "auth".into(),
            owner.into(),
            String::new(),
            schnorr(signer, &digest),
        ]
    }
    fn encrypt(from: [u8; 32], to: &str, plaintext: &str) -> String {
        nip44::encrypt(
            &SecretKey::from_slice(&from).unwrap(),
            &PublicKey::from_hex(to).unwrap(),
            plaintext,
            nip44::Version::V2,
        )
        .unwrap()
    }
    fn sign(secret: [u8; 32], kind: u16, tags: &[Vec<String>], content: &str) -> serde_json::Value {
        let pubkey = hex_of(secret);
        let created = 1_800_000_000u64;
        let hash = Sha256::digest(
            serde_json::to_vec(&json!([0, pubkey, created, kind, tags, content])).unwrap(),
        );
        json!({
            "id": format!("{hash:x}"), "pubkey": pubkey, "created_at": created,
            "kind": kind, "tags": tags, "content": content, "sig": schnorr(secret, &hash)
        })
    }
    fn payload(machine_id: &str, status: &str) -> serde_json::Value {
        json!({
            "v": 1, "status": status, "machineId": machine_id, "name": "Omarchy",
            "host": "omarchy", "platform": "linux", "runtimes": ["claude", "codex"],
            "capabilities": { "desktop": true, "docker": false },
            "routes": [
                { "type": "iroh", "nodeId": "ab12", "endpointAddr": "eyJpZCI6ImFiIn0" },
                { "type": "wss", "url": "wss://omarchy.example.org/_buzz-host" },
                { "type": "carrier-pigeon", "coop": 7 }
            ],
            "agents": [{ "pubkey": hex_of([9; 32]), "name": "haiku" }],
            "publicGuestUrl": null, "updatedAt": 1_800_000_000u64
        })
    }
    fn tags(machine_id: &str) -> Vec<Vec<String>> {
        let viewer = hex_of(VIEWER);
        vec![
            vec!["d".into(), format!("buzz-host:{machine_id}")],
            vec!["k".into(), STATUS_TOPIC.into()],
            vec!["p".into(), viewer.clone()],
            auth(VIEWER, &viewer, &hex_of(MACHINE)),
        ]
    }
    /// A machine status event signed by MACHINE, its content encrypted to VIEWER.
    fn status_event(tags: &[Vec<String>], payload: &serde_json::Value) -> serde_json::Value {
        let content = encrypt(MACHINE, &hex_of(VIEWER), &payload.to_string());
        sign(MACHINE, STATUS_KIND, tags, &content)
    }
    async fn verify(events: Vec<serde_json::Value>) -> Vec<VerifiedRemoteMachineStatus> {
        verify_statuses(&IdentityHost::fixture(), events)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn accepts_a_signed_attested_encrypted_status() {
        let event = status_event(&tags("m-1"), &payload("m-1", "online"));
        let [status] = &verify(vec![event.clone()]).await[..] else {
            panic!("expected one verified status");
        };
        assert_eq!(status.event_id, event["id"]);
        assert_eq!(status.pubkey, hex_of(MACHINE));
        assert_eq!(status.created_at, 1_800_000_000);
        assert_eq!(status.payload.status, MachineState::Online);
        assert_eq!(status.payload.machine_id, "m-1");
        // Unknown route types are skipped, known ones kept in order.
        assert_eq!(
            status.payload.routes,
            vec![
                Route::Iroh {
                    node_id: "ab12".into(),
                    endpoint_addr: Some("eyJpZCI6ImFiIn0".into())
                },
                Route::Wss {
                    url: "wss://omarchy.example.org/_buzz-host".into()
                },
            ]
        );
        assert_eq!(status.payload.agents[0].pubkey, hex_of([9; 32]));
        let wire = serde_json::to_value(status).unwrap();
        assert_eq!(wire["payload"]["machineId"], "m-1");
        assert_eq!(wire["payload"]["routes"][0]["nodeId"], "ab12");
        assert_eq!(wire["createdAt"], 1_800_000_000u64);
    }

    #[tokio::test]
    async fn accepts_a_stopped_status() {
        let event = status_event(&tags("m-1"), &payload("m-1", "stopped"));
        let statuses = verify(vec![event]).await;
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].payload.status, MachineState::Stopped);
    }

    #[tokio::test]
    async fn rejects_tampered_events_without_aborting_the_batch() {
        let valid = status_event(&tags("m-1"), &payload("m-1", "online"));
        let mut content = valid.clone();
        content["content"] = json!(encrypt(MACHINE, &hex_of(VIEWER), "{}"));
        let mut sig = valid.clone();
        sig["sig"] = json!(schnorr(STRANGER, &[0; 32]));
        let mut tags_changed = valid.clone();
        tags_changed["tags"][2][1] = json!(hex_of(STRANGER));
        let statuses = verify(vec![content, sig, tags_changed, valid]).await;
        assert_eq!(statuses.len(), 1, "only the untouched event survives");
    }

    #[tokio::test]
    async fn rejects_missing_wrong_owner_and_forged_attestations() {
        let viewer = hex_of(VIEWER);
        let machine = hex_of(MACHINE);
        let with_auth = |auth: Option<Vec<String>>| {
            let mut tags = tags("m-1");
            tags.pop();
            tags.extend(auth);
            status_event(&tags, &payload("m-1", "online"))
        };
        let missing = with_auth(None);
        // Validly signed, but by someone who is not the signed-in viewer.
        let wrong_owner = with_auth(Some(auth(STRANGER, &hex_of(STRANGER), &machine)));
        // Claims the viewer as owner, signed by someone else.
        let forged = with_auth(Some(auth(STRANGER, &viewer, &machine)));
        // The viewer's real proof, but for a different agent key.
        let other_agent = with_auth(Some(auth(VIEWER, &viewer, &hex_of(STRANGER))));
        let mut conditioned = auth(VIEWER, &viewer, &machine);
        conditioned[2] = "kind=1".into();
        let conditioned = with_auth(Some(conditioned));
        let mut twice = tags("m-1");
        twice.push(auth(VIEWER, &viewer, &machine));
        let twice = status_event(&twice, &payload("m-1", "online"));
        let events = vec![
            missing,
            wrong_owner,
            forged,
            other_agent,
            conditioned,
            twice,
        ];
        assert!(verify(events).await.is_empty());
    }

    #[tokio::test]
    async fn rejects_coordinate_topic_recipient_and_kind_mismatches() {
        let mismatched = status_event(&tags("m-2"), &payload("m-1", "online"));
        let unprefixed = {
            let mut tags = tags("m-1");
            tags[0][1] = "m-1".into();
            status_event(&tags, &payload("m-1", "online"))
        };
        let no_topic = {
            let mut tags = tags("m-1");
            tags.remove(1);
            status_event(&tags, &payload("m-1", "online"))
        };
        let other_recipient = {
            let mut tags = tags("m-1");
            tags[2][1] = hex_of(STRANGER);
            status_event(&tags, &payload("m-1", "online"))
        };
        let wrong_kind = sign(
            MACHINE,
            30078,
            &tags("m-1"),
            &encrypt(
                MACHINE,
                &hex_of(VIEWER),
                &payload("m-1", "online").to_string(),
            ),
        );
        let events = vec![
            mismatched,
            unprefixed,
            no_topic,
            other_recipient,
            wrong_kind,
        ];
        assert!(verify(events).await.is_empty());
    }

    #[tokio::test]
    async fn rejects_undecryptable_content() {
        let plaintext = payload("m-1", "online").to_string();
        // Encrypted to someone else, and not NIP-44 at all.
        let elsewhere = sign(
            MACHINE,
            STATUS_KIND,
            &tags("m-1"),
            &encrypt(MACHINE, &hex_of(STRANGER), &plaintext),
        );
        let garbage = sign(MACHINE, STATUS_KIND, &tags("m-1"), "not-nip44");
        assert!(verify(vec![elsewhere, garbage]).await.is_empty());
    }

    #[tokio::test]
    async fn rejects_invalid_payloads() {
        let with = |edit: fn(&mut serde_json::Value)| {
            let mut payload = payload("m-1", "online");
            edit(&mut payload);
            status_event(&tags("m-1"), &payload)
        };
        let events = vec![
            with(|p| p["v"] = json!(2)),
            with(|p| p["status"] = json!("sleeping")),
            with(|p| p["name"] = json!(" ")),
            with(|p| p["routes"] = json!([{ "type": "wss", "url": "ws://insecure" }])),
            with(|p| p["routes"] = json!([{ "type": "iroh" }])),
            with(|p| p["agents"] = json!([{ "pubkey": "ABC" }])),
            with(|p| p["publicGuestUrl"] = json!("https://example.org")),
            with(|p| {
                p.as_object_mut().unwrap().remove("updatedAt");
            }),
        ];
        assert!(verify(events).await.is_empty());
    }

    #[tokio::test]
    async fn decrypt_from_peer_is_bounded_and_peer_specific() {
        let host = IdentityHost::fixture();
        let viewer = hex_of(VIEWER);
        let sealed = encrypt(MACHINE, &viewer, "hello");
        assert_eq!(
            host.decrypt_from_peer(&hex_of(MACHINE), &sealed)
                .await
                .unwrap(),
            "hello"
        );
        assert!(host
            .decrypt_from_peer(&hex_of(STRANGER), &sealed)
            .await
            .is_err());
        assert!(host.decrypt_from_peer("not-a-key", &sealed).await.is_err());
        let oversized = "A".repeat(64 * 1024 + 1);
        assert!(host
            .decrypt_from_peer(&hex_of(MACHINE), &oversized)
            .await
            .is_err());
    }
}
