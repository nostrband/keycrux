import { bytesToHex } from "@noble/hashes/utils";
import { verifyBuild, verifyInstance, verifyRelease } from "./aws";
import { nsmGetAttestation, nsmParseAttestation } from "./nsm";
import { InstanceInfo } from "./types";
import fs from "node:fs";
import { Event } from "nostr-tools";

export async function getInfo(parentUrl: string) {
  const run = async () => {
    // get build and instance info from the enclave parent
    // and verify that info matches our own attestation
    const ws = new WebSocket(parentUrl);
    const reply = await new Promise<InstanceInfo | null>((ok, err) => {
      let timer: NodeJS.Timeout | undefined;

      ws.onerror = (e) => {
        err("Parent connection failed " + e);
        if (timer) clearTimeout(timer);
      };

      ws.onopen = () => {
        try {
          const att = nsmGetAttestation();
          if (!att) {
            ok({});
            return;
          }

          const releasePolicy = JSON.parse(
            fs.readFileSync("release.json").toString("utf8")
          );
          if (
            !releasePolicy.signer_pubkeys ||
            !releasePolicy.signer_pubkeys.length
          )
            throw new Error("No signer pubkeys");

          // return null to retry on timeout,
          // 20sec timeout to fetch outbox relays
          timer = setTimeout(() => {
            console.log(new Date(), "parent timeout");
            ws.close();
            ok(null);
          }, 20000);

          const attData = nsmParseAttestation(att);

          ws.onmessage = (ev) => {
            console.log(new Date(), "parent reply", ev.data);
            clearTimeout(timer);
            const data = ev.data.toString("utf8");
            try {
              const r = JSON.parse(data);
              if (r.id !== "start") throw new Error("Bad reply id");
              if (r.error) throw new Error(r.error);
              const {
                build,
                instance,
                releases,
                instanceAnnounceRelays,
                prod,
              } = JSON.parse(r.result);
              if (!build || !instance) throw new Error("Bad reply");

              const notDebug = !!attData.pcrs.get(0)!.find((c) => c !== 0);
              if (notDebug) {
                if (!build || !instance || !releases)
                  throw new Error("Bad reply");
                verifyBuild(attData, build);
                verifyInstance(attData, instance);
                for (const release of releases) verifyRelease(attData, release);
                for (const pubkey of releasePolicy.signer_pubkeys) {
                  if (!releases.find((r: Event) => r.pubkey === pubkey))
                    throw new Error("Release signer not found");
                }
              } else {
                // attestation has empty pcr8 and pcr4...
                if (
                  instance.tags.find(
                    (t: string[]) => t.length > 1 && t[0] === "PCR4"
                  )?.[1] !== bytesToHex(attData.pcrs.get(4)!)
                )
                  throw new Error("Invalid instance info from parent");
              }
              console.log(
                new Date(),
                "got valid build and instance info",
                build,
                instance
              );
              ok({
                build,
                instance,
                releases,
                releasePolicy,
                instanceAnnounceRelays,
                prod,
              });
            } catch (e: any) {
              console.log("parent reply error", e, data);
              err(e.message || e.toString());
            } finally {
              ws.close();
            }
          };

          // send request
          console.log(new Date(), "requesting parent start...");
          ws.send(
            JSON.stringify({
              id: "start",
              method: "start",
              params: [att.toString("base64")],
            })
          );
        } catch (e: any) {
          console.log("onopen error", e);
          err(e.message || e.toString());
          ws.close();
        }
      };
    });
    if (reply === null) {
      // pause and retry
      console.log(new Date(), "Failed to get info from parent, will retry...");
      return undefined;
    } else {
      return reply;
    }
  };

  let reply: InstanceInfo | undefined;
  while (!(reply = await run())) {
    // pause and retry
    await new Promise((ok) => setTimeout(ok, 3000));
  }

  return reply;
}
