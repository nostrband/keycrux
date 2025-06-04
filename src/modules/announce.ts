import { Event } from "nostr-tools";
import { nsmGetAttestationInfo } from "./nsm";
import { ANNOUNCEMENT_INTERVAL } from "./consts";
import { Signer } from "./types";
import {
  prepareRootCertificate,
  publishInstance,
  publishInstanceProfile,
  publishNip65Relays,
  publishStats,
} from "./nostr";
import { SocksProxyAgent } from "socks-proxy-agent";

export interface AnnounceParams {
  agent: SocksProxyAgent;
  build?: Event;
  instance?: Event;
  releases?: Event[];
  signer: Signer;
  inboxRelayUrl: string;
  instanceAnnounceRelays?: string[];
  prod?: boolean;
  open?: boolean;
  getStats?: () => Promise<Map<string, string>>;
}

async function announce(p: AnnounceParams) {
  const pubkey = p.signer.getPublicKey();

  // attestation
  const attestation = nsmGetAttestationInfo(pubkey, p.prod);
  console.log("attestation", attestation);

  // root cert / aws attestation event
  const root = await prepareRootCertificate(attestation, p.signer);

  // kind 10002
  await publishNip65Relays(p.signer, p.instanceAnnounceRelays, p.agent);

  // kind 63793
  await publishInstance(p, attestation, root, p.agent);

  // kind 0
  await publishInstanceProfile(
    p.signer,
    attestation.env,
    p.instanceAnnounceRelays,
    p.agent
  );

  // kind 1
  if (p.getStats)
    await publishStats(p.signer, await p.getStats(), p.instanceAnnounceRelays, p.agent);
}

export function startAnnouncing(opt: AnnounceParams) {
  const tryAnnounce = async () => {
    try {
      await announce(opt);

      // schedule next announcement
      setTimeout(tryAnnounce, ANNOUNCEMENT_INTERVAL);
    } catch (e) {
      console.log("Failed to announce", e);

      // retry faster than normal
      setTimeout(tryAnnounce, ANNOUNCEMENT_INTERVAL / 10);
    }
  };
  tryAnnounce();
}
