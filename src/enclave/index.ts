import { SocksProxyAgent } from "socks-proxy-agent";
import {
  Event,
  generateSecretKey,
  getPublicKey,
  validateEvent,
  verifyEvent,
} from "nostr-tools";
import { Relay } from "../modules/relay";
import { getInfo } from "../modules/parent";
import { RequestListener } from "../modules/listeners";
import { startAnnouncing } from "../modules/announce";
import { Reply, Request, Server } from "../modules/server";
import { Signer } from "../modules/types";
import { PrivateKeySigner } from "../modules/signer";
import { Validator } from "nostr-enclaves";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { now } from "../modules/utils";
import { DATA_TTL, DEBUG } from "../modules/consts";

interface Policy {
  ref?: string;
  release_pubkeys?: string[];
}

interface PolicyInput {
  ref?: string;
  release_signatures?: Event[];
}

interface Data {
  PCR0: string;
  PCR1: string;
  PCR2: string;
  PCR4: string;
  data: string;
  expiry: number;
  policy?: Policy;
}

class KeycruxServer extends Server {
  private validator = new Validator({
    printLogs: true,
  });
  private data = new Map<string, Data>();
  private pcr4 = new Map<string, Set<string>>();

  constructor(signer: Signer) {
    super(signer);
  }

  public GC() {
    const expired: [string, string][] = [];
    const tm = now();
    for (const [key, data] of this.data.entries()) {
      if (data.expiry < tm) {
        expired.push([key, data.PCR4]);
      }
    }
    for (const [key, PCR4] of expired) {
      this.data.delete(key);
      this.pcr4.get(PCR4)!.delete(key);
    }
  }

  private async parse(req: Request): Promise<Data> {
    let pcrs: Map<number, Uint8Array> | undefined;
    if (DEBUG) {
      pcrs = new Map(JSON.parse(req.params.attestation)) as Map<
        number,
        Uint8Array
      >;
    } else {
      const attData = await this.validator.parseValidateAttestation(
        req.params.attestation,
        req.pubkey
      );
      pcrs = attData.pcrs;
    }
    return {
      data: req.params.data,
      expiry: now() + DATA_TTL,
      PCR0: bytesToHex(pcrs.get(0) || new Uint8Array()),
      PCR1: bytesToHex(pcrs.get(1) || new Uint8Array()),
      PCR2: bytesToHex(pcrs.get(2) || new Uint8Array()),
      PCR4: bytesToHex(pcrs.get(4) || new Uint8Array()),
      policy: req.params.policy,
    };
  }

  private key(data: Data) {
    return bytesToHex(
      sha256([data.PCR0, data.PCR1, data.PCR2, data.PCR4].join("_"))
    );
  }

  private checkPolicy(data: Data, input: PolicyInput) {
    const policy = data.policy!;

    // ref required and wrong provided? skip
    if (policy.ref && policy.ref !== input.ref) return false;

    // release signatures required?
    if (policy.release_pubkeys && policy.release_pubkeys.length > 0) {
      const sigs = input.release_signatures as Event[];
      if (!sigs || sigs.length < policy.release_pubkeys.length) return false;

      // check sigs for pubkeys
      for (const pubkey of policy.release_pubkeys) {
        const sig = sigs.find((e) => e.pubkey === pubkey);
        if (!sig) return false;
        const ref = sig.tags.find((t) => t.length > 1 && t[0] === "r")?.[1];
        if (ref !== policy.ref) return false;
        if (!validateEvent(sig) || !verifyEvent(sig)) return false;

        // check sig pcrs
        const pcr = (i: number) => {
          return (
            sig.tags.find((t) => t.length > 1 && t[0] === "PCR" + i)?.[1] || ""
          );
        };
        if (
          pcr(0) !== data.PCR0 ||
          pcr(1) !== data.PCR1 ||
          pcr(2) !== data.PCR2
        )
          return false;
      }
    }

    return true;
  }

  protected async get(request: Request, res: Reply): Promise<void> {
    const req = await this.parse(request);
    const key = this.key(req);
    if (this.data.has(key)) {
      res.result = this.data.get(key)!.data;
      return;
    }

    const keysFromPCR4 = this.pcr4.get(req.PCR4) || new Set();
    for (const key of keysFromPCR4) {
      const data = this.data.get(key);
      if (!data) throw new Error("Internal error, wrong PCR4 index");

      // wrong ec2 instance? skip
      if (req.PCR4 !== data.PCR4) continue;

      // key has policy attached?
      if (data.policy) {
        // no input in request? skip
        if (!request.params.input) continue;

        const input = request.params.input as PolicyInput;
        if (this.checkPolicy(data, input)) continue;
      }
    }

    res.error = "Not found";
  }

  protected async set(req: Request, res: Reply): Promise<void> {
    const data = await this.parse(req);

    // check their own policy
    if (data.policy) {
      if (!req.params.input) throw new Error("No input for policy");
      const input = req.params.input as PolicyInput;
      if (!this.checkPolicy(data, input))
        throw new Error("Policy check failed");
    }

    // store the data
    const key = this.key(data);
    this.data.set(key, data);

    // index by pcr4
    const keysFromPCR4 = this.pcr4.get(data.PCR4) || new Set<string>();
    keysFromPCR4.add(key);
    this.pcr4.set(data.PCR4, keysFromPCR4);

    // ok
    res.result = "ok";
  }
}

async function startBackground(server: KeycruxServer) {
  while (true) {
    server.GC();
    await new Promise((ok) => setTimeout(ok, 10000));
  }
}

export async function startEnclave(opts: {
  relayUrl: string;
  proxyUrl: string;
  parentUrl: string;
}) {
  console.log(new Date(), "opts", opts);
  const { build, instance, instanceAnnounceRelays, prod } = await getInfo(
    opts.parentUrl
  );

  // we're talking to the outside world using socks proxy
  // that lives in enclave parent and our tcp traffic
  // is socat-ed through vsock interface
  const agent = new SocksProxyAgent(opts.proxyUrl);

  // new key on every restart
  const servicePrivkey = generateSecretKey();
  const servicePubkey = getPublicKey(servicePrivkey);
  const serviceSigner = new PrivateKeySigner(servicePrivkey);
  console.log("servicePubkey", servicePubkey);

  const server = new KeycruxServer(serviceSigner);

  // request handler
  const process = async (e: Event, relay: Relay) => {
    const reply = await server.process(e);
    if (!reply) return; // ignored
    try {
      await relay.publish(reply);
    } catch (err) {
      console.log("failed to publish reply");
      relay.reconnect();
    }
  };

  let reqsTotal = 0;
  const requestListener = new RequestListener(agent, {
    onRequest: async (relay: Relay, pubkey: string, e: Event) => {
      reqsTotal++;
      if (pubkey !== servicePubkey) throw new Error("Unknown key");
      await process(e, relay);
    },
  });

  // listen to requests
  requestListener.addPubkey(servicePubkey, [opts.relayUrl]);

  const getStats = async () => {
    const stats = new Map<string, string>();
    stats.set("keys", "");
    return stats;
  };

  // announce ourselves
  startAnnouncing({
    agent,
    build,
    instance,
    signer: serviceSigner,
    inboxRelayUrl: opts.relayUrl,
    instanceAnnounceRelays,
    open: true,
    prod,
    getStats,
  });

  // GC
  startBackground(server);
}

// main
export function mainEnclave(argv: string[]) {
  if (!argv.length) throw new Error("Service not specified");
  if (argv[0] === "run") {
    const proxyUrl = argv?.[1] || "socks://127.0.0.1:1080";
    const parentUrl = argv?.[2] || "ws://127.0.0.1:2080";
    const relayUrl = argv?.[3] || "wss://relay.enclaved.org";
    startEnclave({ proxyUrl, parentUrl, relayUrl });
  }
}
