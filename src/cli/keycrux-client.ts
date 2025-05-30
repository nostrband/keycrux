import { bytesToHex } from "@noble/hashes/utils";
import { generateSecretKey } from "nostr-tools";
import { KIND_KEY_RPC } from "../modules/consts";
import fs from "node:fs";
import { Client } from "./client";

export class KeycruxClient extends Client {
  private filename?: string;

  constructor({
    relayUrl,
    filename,
    signerPubkey,
    privkey,
  }: {
    relayUrl: string;
    filename?: string;
    signerPubkey: string;
    privkey?: Uint8Array;
  }) {
    super({ relayUrl, kind: KIND_KEY_RPC, signerPubkey, privkey });
    this.filename = filename;
  }

  public async start() {
    if (this.filename) {
      try {
        const data = fs.readFileSync(this.filename).toString("utf8");
        const { csk, spk } = JSON.parse(data);
        if (csk && spk) {
          this.privkey = Buffer.from(csk, "hex");
          this.signerPubkey = spk;
        }
      } catch {}
    }

    if (!this.privkey) {
      this.privkey = generateSecretKey();
    }
    this.subscribe();

    if (this.filename) {
      fs.writeFileSync(
        this.filename,
        JSON.stringify({
          csk: bytesToHex(this.privkey!),
          spk: this.signerPubkey,
        })
      );
    }
  }
}
