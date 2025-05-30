import { open, getAttestationDoc, close } from "aws-nitro-enclaves-nsm-node";
import { decode } from "cbor2";
import { AttestationData, AttestationInfo } from "./types";

let fd: number = -1;

export function nsmInit() {
  fd = open();
}

export function nsmDeinit() {
  if (fd >= 0) close(fd);
  fd = -1;
}

export function nsmGetAttestation(pubkey?: string) {
  if (fd < 0) return "";

  return getAttestationDoc(
    fd,
    null, // user data
    null, // nonce
    pubkey ? Buffer.from(pubkey, "hex") : null
  );
}

export function nsmParseAttestation(att: Buffer) {
  const COSE_Sign1: Uint8Array[] = decode(att);
  console.log("COSE_Sign1", COSE_Sign1);
  if (COSE_Sign1.length !== 4) throw new Error("Bad attestation");

  const data: AttestationData = decode(COSE_Sign1[2]);
  console.log("data", data);
  return data;
}

export function nsmGetAttestationInfo(pubkey: string, prod?: boolean) {
  const attestation = nsmGetAttestation(pubkey);
  console.log("attestation", attestation);
  const r: AttestationInfo = {
    info: undefined,
    env: "debug",
    base64: "",
  };
  if (!attestation) return r;

  r.base64 = attestation.toString("base64");
  r.info = nsmParseAttestation(attestation);
  // PCR0=all_zeroes means we're in debug mode
  r.env = !r.info.pcrs.get(0)!.find((v) => v !== 0)
    ? "debug"
    : prod
    ? "prod"
    : "dev";

  return r;
}
