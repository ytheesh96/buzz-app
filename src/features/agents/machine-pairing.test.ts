import { describe, expect, it } from "vitest";
import {
  offerMachinePairing,
  parseMachinePairingLink,
  peekMachinePairing,
  SELF_HOSTED_SETTINGS_TARGET,
  subscribeMachinePairing,
  takeMachinePairing,
} from "./machine-pairing";
import { parseOpenTarget } from "../navigation/targets";

const token = "bha_0123456789abcdefABCDEF_-";
const link = (query: string, fragment = `token=${token}`) =>
  `buzz://pair?${query}#${fragment}`;

describe("buzz://pair links", () => {
  it("reads the URL, name and fragment token buzz-host pair prints", () => {
    expect(
      parseMachinePairingLink(
        link("url=wss%3A%2F%2Fbox.example.org%2F_buzz-host&name=My%20Box"),
      ),
    ).toMatchObject({
      url: "wss://box.example.org/_buzz-host",
      token,
      name: "My Box",
    });
    // Loopback ws:// follows the Add machine form's rules (saved as 127.0.0.1).
    const local = parseMachinePairingLink(
      link("url=ws%3A%2F%2Flocalhost%3A8467"),
    );
    expect(local).toMatchObject({ url: "ws://127.0.0.1:8467", token });
    expect(local && "name" in local).toBe(false);
    // Windows' explicit root path, and a guest token.
    expect(
      parseMachinePairingLink(
        `buzz://pair/?url=wss%3A%2F%2Fh.example#token=bhg_abcdefgh12`,
      )?.token,
    ).toBe("bhg_abcdefgh12");
  });

  it("rejects anything that is not exactly a safe pairing link", () => {
    for (const bad of [
      link("url=ws%3A%2F%2Fbox.example.org%3A8467"),
      link("url=http%3A%2F%2Fbox.example.org"),
      link("url=wss%3A%2F%2Fa.example&url=wss%3A%2F%2Fb.example"),
      link("url=wss%3A%2F%2Fa.example%23token%3Dbha_zzzzzzzzzz"),
      link("url=wss%3A%2F%2Fa.example", "token=nope"),
      link("url=wss%3A%2F%2Fa.example", ""),
      link("url=wss%3A%2F%2Fa.example", `token=${token}&token=${token}`),
      link("url=wss%3A%2F%2Fa.example&name=a%0Ab"),
      link(`url=wss%3A%2F%2Fa.example&name=${"x".repeat(101)}`),
      link(""),
      `buzz://pair?url=wss%3A%2F%2Fa.example&token=${token}`,
      `buzz://pairing?url=wss%3A%2F%2Fa.example#token=${token}`,
      `buzz://pair/extra?url=wss%3A%2F%2Fa.example#token=${token}`,
      `https://pair?url=wss%3A%2F%2Fa.example#token=${token}`,
    ])
      expect(parseMachinePairingLink(bad), bad).toBeNull();
  });

  it("opens Agent setup's Self-hosted dialog, a valid Settings target", () => {
    expect(parseOpenTarget(SELF_HOSTED_SETTINGS_TARGET)).toEqual(
      SELF_HOSTED_SETTINGS_TARGET,
    );
  });

  it("holds the latest pairing in memory until the form consumes it", () => {
    const first = parseMachinePairingLink(link("url=wss%3A%2F%2Fa.example"));
    const second = parseMachinePairingLink(link("url=wss%3A%2F%2Fb.example"));
    if (!first || !second) throw new Error("expected pairings");
    expect(second.id).not.toBe(first.id);
    let calls = 0;
    const stop = subscribeMachinePairing(() => calls++);
    offerMachinePairing(first);
    offerMachinePairing(second);
    expect(calls).toBe(2);
    expect(peekMachinePairing()).toBe(second);
    takeMachinePairing(first.id);
    expect(peekMachinePairing()).toBe(second);
    takeMachinePairing(second.id);
    expect(peekMachinePairing()).toBeUndefined();
    stop();
    offerMachinePairing(first);
    expect(calls).toBe(2);
    takeMachinePairing(first.id);
  });
});
