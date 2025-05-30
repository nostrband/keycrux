import { bytesToHex, randomBytes } from "@noble/hashes/utils";
import { Event, finalizeEvent, getPublicKey } from "nostr-tools";
import { Relay } from "../modules/relay";
import { KIND_NIP46 } from "../modules/consts";
import { Nip44 } from "../modules/nip44";
import { now } from "../modules/utils";

const nip44 = new Nip44();

export class Client {
  protected kind: number;
  protected relay: Relay;
  protected signerPubkey?: string;

  protected privkey?: Uint8Array;
  private done = new Set<string>();
  private pending = new Map<
    string,
    {
      ok: (result: string) => void;
      err: (e: any) => void;
    }
  >();

  constructor({
    relayUrl,
    kind = KIND_NIP46,
    signerPubkey,
    privkey,
  }: {
    relayUrl: string;
    kind?: number;
    signerPubkey?: string;
    privkey?: Uint8Array;
  }) {
    this.kind = kind;
    this.relay = new Relay(relayUrl);
    this.signerPubkey = signerPubkey;
    this.privkey = privkey;
  }

  public getRelay() {
    return this.relay;
  }

  public async send({
    method,
    params,
    timeout = 30000,
  }: {
    method: string;
    params: any;
    timeout?: number;
  }) {
    if (!this.privkey || !this.signerPubkey) throw new Error("Not started");

    const req = {
      id: bytesToHex(randomBytes(6)),
      method,
      params,
    };

    const event = finalizeEvent(
      {
        created_at: Math.floor(Date.now() / 1000),
        kind: this.kind,
        content: nip44.encrypt(
          this.privkey,
          this.signerPubkey,
          JSON.stringify(req)
        ),
        tags: [["p", this.signerPubkey]],
      },
      this.privkey
    );
    console.log("sending", event);
    await this.relay.publish(event);

    return new Promise<string>((ok, err) => {
      this.pending.set(req.id, { ok, err });
      setTimeout(() => {
        const cbs = this.pending.get(req.id);
        if (cbs) {
          this.pending.delete(req.id);
          cbs.err("Request timeout");
        }
      }, timeout);
    });
  }

  private onReplyEvent(e: Event) {
    const { id, result, error } = JSON.parse(
      nip44.decrypt(this.privkey!, this.signerPubkey!, e.content)
    );
    console.log("reply", { id, result, error });
    if (result === "auth_url") {
      console.log("Open auth url: ", error);
      return;
    }

    const cbs = this.pending.get(id);
    if (!cbs) return;
    this.pending.delete(id);

    if (error) cbs.err(error);
    else cbs.ok(result);
  }

  protected subscribe() {
    this.relay.req({
      fetch: false,
      id: bytesToHex(randomBytes(6)),
      filter: {
        kinds: [this.kind],
        authors: [this.signerPubkey!],
        "#p": [getPublicKey(this.privkey!)],
        since: now() - 10,
      },
      onEvent: this.onReplyEvent.bind(this),
    });
  }
}
