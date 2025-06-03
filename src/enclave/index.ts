import { SocksProxyAgent } from "socks-proxy-agent";
import { Event, generateSecretKey, getPublicKey } from "nostr-tools";
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
import { DATA_TTL } from "../modules/consts";

interface Data {
  data: string;
  expiry: number;
}

class KeycruxServer extends Server {
  private validator = new Validator({
    printLogs: true,
  });
  private data = new Map<string, Data>();

  constructor(signer: Signer) {
    super(signer);
  }

  private parse(attestation: string, pubkey: string) {
    if (process.env["TEST"] === "true") {
      return {
        public_key: new Uint8Array(),
        certificate: new Uint8Array(),
        cabundle: [] as Uint8Array[],
        pcrs: new Map(JSON.parse(attestation)) as Map<number, Uint8Array>,

      };
    } else {
      return this.validator.parseValidateAttestation(attestation, pubkey);
    }
  }

  private key(
    info: Awaited<ReturnType<typeof this.validator.parseValidateAttestation>>
  ) {
    // image
    const PCR0 = info.pcrs.get(0);
    const PCR1 = info.pcrs.get(1);
    const PCR2 = info.pcrs.get(2);
    // instance
    const instancePCR = info.pcrs.get(4);

    return bytesToHex(sha256([PCR0, PCR1, PCR2, instancePCR].join("_")));
  }

  protected async get(req: Request, res: Reply): Promise<void> {
    const info = await this.parse(req.params.attestation, req.pubkey);
    const key = this.key(info);
    if (this.data.has(key)) {
      res.result = this.data.get(key)!.data;
      return;
    }

    // FIXME now we have to get smarter:
    // - find history of releases for the current PCR0,
    // - check each PCR0 of older releases as key,
    // - if found - the current instance upgraded, return keys to them

    res.error = "Not found";
  }

  protected async set(req: Request, res: Reply): Promise<void> {
    const info = await this.parse(req.params.attestation, req.pubkey);
    const key = this.key(info);
    this.data.set(key, {
      data: req.params.data,
      expiry: now() + DATA_TTL,
    });
    res.result = "ok";
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
