import { Event, UnsignedEvent } from "nostr-tools";

export interface Signer {
  getPublicKey(): string;

  signEvent(event: UnsignedEvent): Promise<Event>;

  nip04Encrypt(pubkey: string, data: string): Promise<string>;

  nip04Decrypt(pubkey: string, data: string): Promise<string>;

  nip44Encrypt(pubkey: string, data: string): Promise<string>;

  nip44Decrypt(pubkey: string, data: string): Promise<string>;
}

export interface Nip46Req {
  clientPubkey: string;
  id: string;
  method: string;
  params: string[];
}

export interface AttestationData {
  certificate: Uint8Array;
  pcrs: Map<number, Uint8Array>;
  module_id: string;
}

export interface AttestationInfo {
  info: AttestationData | undefined;
  base64: string;
  env: "debug" | "dev" | "prod";
}

export interface ReleasePolicy {
  signer_pubkeys: string[];
}

export interface InstanceInfo {
  build?: Event;
  instance?: Event;
  releases?: Event[];
  releasePolicy?: ReleasePolicy;
  instanceAnnounceRelays?: string[];
  prod?: boolean;
}
