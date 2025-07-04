import { nsmInit } from "../modules/nsm";

// run ASAP to override crypto.getRandomValues
nsmInit();

import { WebSocket } from "ws";
import { startEnclave } from ".";

// @ts-ignore
global.WebSocket ??= WebSocket;

// used to launch the process inside the enclave
const proxyUrl = process.argv?.[2] || "socks://127.0.0.1:1080";
const parentUrl = process.argv?.[3] || "ws://127.0.0.1:2080";
const relayUrl = process.argv?.[4] || "wss://relay.enclaved.org";
startEnclave({ proxyUrl, parentUrl, relayUrl }).catch(e => {
  console.error("Failed, terminating", e);
  throw e;
});
