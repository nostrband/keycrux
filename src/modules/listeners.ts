import { SocksProxyAgent } from "socks-proxy-agent";
import { Event } from "nostr-tools";
import { Relay } from "./relay";
import { PubkeyBatcher, now } from "./utils";
import { KIND_KEY_RPC } from "./consts";

const BATCH_SIZE = 100;

export class RequestListener {
  private agent: SocksProxyAgent;
  private relays = new Map<string, Relay>();
  private onRequest: (relay: Relay, pubkey: string, event: Event) => void;
  private pubkeys = new PubkeyBatcher(BATCH_SIZE);

  constructor(
    agent: SocksProxyAgent,
    {
      onRequest,
    }: { onRequest: (relay: Relay, pubkey: string, event: Event) => void }
  ) {
    this.agent = agent;
    this.onRequest = onRequest;
  }

  private onEvent(relay: Relay, event: Event) {
    switch (event.kind) {
      case KIND_KEY_RPC:
        const p = event.tags.find((t) => t.length > 1 && t[0] === "p")?.[1];
        if (!p || !this.pubkeys.has(p)) {
          console.log("Unknown pubkey", event);
          return;
        }
        this.onRequest(relay, p, event);
        break;
      default:
        throw new Error("Invalid kind");
    }
  }

  private req(relay: Relay, id: string, pubkeys: string[]) {
    relay.req({
      id,
      fetch: false,
      filter: {
        "#p": pubkeys,
        kinds: [KIND_KEY_RPC],
        since: now() - 10,
      },
      onClosed: () => relay.close(id),
      onEvent: (e: Event) => this.onEvent(relay, e),
    });
  }

  public addPubkey(pubkey: string, relays: string[]) {
    for (const url of relays) {
      const [id, pubkeys] = this.pubkeys.add(pubkey, url);
      if (!id) continue;

      // forward-looking subscription watching
      // for new requests, id will be the same to a previous
      // id of a batch so a new REQ will override the old REQ on relay
      const relay = this.relays.get(url) || new Relay(url, this.agent);
      this.relays.set(url, relay);
      this.req(relay, id, pubkeys);
    }
  }

  public removePubkey(pubkey: string) {
    for (const url of this.pubkeys.relays(pubkey)) {
      const [id, pubkeys] = this.pubkeys.remove(pubkey, url);
      if (!id) continue;

      const relay = this.relays.get(url);
      if (!relay) continue; // wtf?

      if (pubkeys.length) {
        this.req(relay, id, pubkeys);
      } else {
        relay.close(id);
      }
    }
  }

  public pubkeyRelays(pubkey: string) {
    return this.pubkeys.relays(pubkey);
  }
}
