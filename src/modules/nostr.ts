import fs from "node:fs";
import { Event, Filter, UnsignedEvent, nip19 } from "nostr-tools";
import { AttestationInfo, Signer } from "./types";
import {
  APP_NAME,
  CERT_TTL,
  KIND_CONTACTS,
  KIND_ANNOUNCEMENT,
  KIND_PROFILE,
  KIND_RELAYS,
  KIND_ROOT_CERTIFICATE,
  REPO,
} from "./consts";
import { normalizeRelay, now } from "./utils";
import { Relay } from "./relay";
import { AnnounceParams } from "./announce";
import { bytesToHex, randomBytes } from "@noble/hashes/utils";
import { SocksProxyAgent } from "socks-proxy-agent";
import { X509Certificate } from "node:crypto";
import { tv } from "nostr-enclaves";

export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "wss://nostr.mom",
  "wss://relay.enclaved.org",
];

export const OUTBOX_RELAYS = [
  "wss://relay.primal.net",
  "wss://relay.nostr.band",
  "wss://purplepag.es",
  "wss://user.kindpag.es",
  "wss://relay.nos.social",
];

export const BLACKLISTED_RELAYS: string[] = [];

export async function publish(
  event: Event,
  relays?: string[],
  agent?: SocksProxyAgent
) {
  const promises = (relays || DEFAULT_RELAYS).map((r) => {
    const relay = new Relay(r, agent);
    return relay.publish(event).finally(() => relay[Symbol.dispose]());
  });
  const results = await Promise.allSettled(promises);
  if (!results.find((r) => r.status === "fulfilled"))
    throw new Error("Failed to publish");
  return event;
}

export async function signPublish(
  event: UnsignedEvent,
  signer: Signer,
  relays?: string[],
  agent?: SocksProxyAgent
) {
  const signed = await signer.signEvent(event);
  return await publish(signed, relays, agent);
}

export async function publishNip65Relays(
  signer: Signer,
  relays?: string[],
  agent?: SocksProxyAgent
) {
  const tmpl: UnsignedEvent = {
    pubkey: signer.getPublicKey(),
    kind: KIND_RELAYS,
    created_at: now(),
    content: "",
    tags: (relays || DEFAULT_RELAYS).map((r) => ["r", r]),
  };

  const event = await signPublish(tmpl, signer, OUTBOX_RELAYS, agent);
  console.log("published outbox relays", event, OUTBOX_RELAYS);
}

export async function prepareRootCertificate(
  info: AttestationInfo,
  signer: Signer
) {
  const cert = new X509Certificate(info.info!.certificate);
  const expiration = Math.floor(cert.validToDate.getTime() / 1000);
  const servicePubkey = await signer.getPublicKey();
  const tmpl: UnsignedEvent = {
    pubkey: servicePubkey,
    kind: KIND_ROOT_CERTIFICATE,
    created_at: now(),
    content: info.base64,
    tags: [
      ["-"],
      ["t", info.env],
      ["expiration", "" + expiration],
      ["alt", "attestation certificate by AWS Nitro Enclave"],
    ],
  };
  return await signer.signEvent(tmpl);
}

export async function publishInstance(
  p: AnnounceParams,
  info: AttestationInfo,
  root: Event,
  agent?: SocksProxyAgent
) {
  const {
    signer,
    prod,
    open,
    build,
    instance,
    releases,
    inboxRelayUrl,
    instanceAnnounceRelays,
  } = p;

  const pkg = JSON.parse(fs.readFileSync("package.json").toString("utf8"));
  console.log("pkg", pkg);

  const pubkey = signer.getPublicKey();

  const ins: UnsignedEvent = {
    pubkey,
    kind: KIND_ANNOUNCEMENT,
    created_at: now(),
    content: "Keycrux: key storage service for enclaved services",
    tags: [
      ["r", REPO],
      ["name", pkg.name],
      ["v", pkg.version],
      ["t", info.env],
      // admin interface relay with spam protection
      ["relay", inboxRelayUrl],
      // expires together with attestation doc
      ["expiration", tv(root, "expiration")],
      ["alt", "keycrux server"],
      // ["o", open ? "true" : "false"],
      ["tee_root", JSON.stringify(root)],
    ],
  };
  if (info.info?.pcrs) {
    ins.tags.push(
      // we don't use PCR3
      ...[0, 1, 2, 4, 8].map((id) => [
        "x",
        bytesToHex(info.info?.pcrs!.get(id)!),
        `PCR${id}`,
      ])
    );
  }
  if (build) {
    ins.tags.push(["build", JSON.stringify(build)]);
    ins.tags.push(["p", build.pubkey, "builder"]);
    const prod_build = build.tags.find(
      (t) => t.length > 1 && t[0] === "t" && t[1] === "prod"
    );
    if (!prod_build && prod) {
      throw new Error("Build is not for production!");
    }
  }
  if (instance) {
    // prof.tags.push(["p", instance.pubkey, "launcher"]);
    ins.tags.push(["instance", JSON.stringify(instance)]);
    ins.tags.push(["p", instance.pubkey, "launcher"]);
    const prod_ins = instance.tags.find(
      (t) => t.length > 1 && t[0] === "t" && t[1] === "prod"
    );
    if (!prod_ins && prod) {
      throw new Error("Instance is not for production!");
    }
  }
  if (releases) {
    for (const release of releases) {
      ins.tags.push(["release", JSON.stringify(release)]);
      ins.tags.push(["p", release.pubkey, "releaser"]);
      const prod_release = release.tags.find(
        (t) => t.length > 1 && t[0] === "t" && t[1] === "prod"
      );
      if (!prod_release && prod) {
        throw new Error("Release is not for production!");
      }
    }
  }

  // publish instance info
  await signPublish(ins, signer, instanceAnnounceRelays, agent);
}

export async function publishInstanceProfile(
  signer: Signer,
  env: string,
  instanceAnnounceRelays?: string[],
  agent?: SocksProxyAgent
) {
  // profile warning
  let warn = "";
  switch (env) {
    case "debug":
      warn =
        "DEBUG INSTANCE, not safe, may break or get terminated at any time!";
      break;
    case "dev":
      warn = "DEVELOPMENT INSTANCE, may break or get terminated at any time!";
      break;
  }

  // profile
  const pubkey = signer.getPublicKey();
  const npub = nip19.npubEncode(pubkey);
  const prof: UnsignedEvent = {
    pubkey,
    kind: KIND_PROFILE,
    created_at: now(),
    content: JSON.stringify({
      name: APP_NAME,
      // picture: "https://nsec.app/favicon.ico",
      about: `The ${
        APP_NAME.substring(0, 1).toUpperCase() + APP_NAME.substring(1)
      } key storage server.\n
  Running inside AWS Nitro Enclave.\n
  Validate instance attestation at https://enclaved.org/instances/${npub}\n
  Learn more at ${REPO}/blob/main/README.md\n
  ${warn}
  `,
    }),
    tags: [
      ["t", APP_NAME],
      ["r", REPO],
    ],
  };

  await signPublish(
    prof,
    signer,
    [...(instanceAnnounceRelays || []), ...OUTBOX_RELAYS],
    agent
  );
}

export async function publishStats(
  signer: Signer,
  stats: Map<string, string>,
  relays?: string[],
  agent?: SocksProxyAgent
) {
  const pubkey = signer.getPublicKey();
  const event: UnsignedEvent = {
    pubkey,
    kind: 1,
    created_at: now(),
    content:
      "Stats:\n" +
      [...stats.entries()].map(([key, value]) => `${key}: ${value}`).join("\n"),
    tags: [["t", "keycrux"]],
  };
  await signPublish(event, signer, relays, agent);
}

export async function fetchFromRelays(
  filter: Filter,
  relayUrls: string[],
  agent?: SocksProxyAgent,
  timeout = 10000
) {
  const relays = relayUrls.map((r) => new Relay(r, agent));
  const reqs = relays.map(
    (r) =>
      new Promise<Event[]>((ok, err) => {
        const timer = setTimeout(() => err("Timeout"), timeout);
        r.req({
          id: bytesToHex(randomBytes(6)),
          fetch: true,
          filter,
          onEOSE(events) {
            clearTimeout(timer);
            ok(events);
          },
        });
      })
  );
  const results = await Promise.allSettled(reqs);
  for (const r of relays) r[Symbol.dispose]();
  const events = results
    .filter((r) => r.status === "fulfilled")
    .map((r) => (r as PromiseFulfilledResult<Event[]>).value)
    .flat();
  const ids = new Set<string>();
  const uniq = events.filter((e) => {
    const has = ids.has(e.id);
    ids.add(e.id);
    return !has;
  });
  return uniq;
}

export function parseRelayEvents(events: Event[]) {
  const pubkeyRelays = new Map<
    string,
    {
      writeRelays: string[];
      readRelays: string[];
    }
  >();

  for (const e of events) {
    const pr = pubkeyRelays.get(e.pubkey) || {
      writeRelays: [],
      readRelays: [],
    };
    if (e.kind === KIND_RELAYS) {
      const filter = (mark: string) => {
        return e.tags
          .filter(
            (t) =>
              t.length >= 2 && t[0] === "r" && (t.length === 2 || t[2] === mark)
          )
          .map((t) => t[1]);
      };
      pr.writeRelays.push(...filter("write"));
      pr.readRelays.push(...filter("read"));
    } else {
      try {
        const relays = JSON.parse(e.content);
        for (const url in relays) {
          if (relays[url].write) pr.writeRelays.push(url);
          if (relays[url].read) pr.readRelays.push(url);
        }
      } catch {}
    }
    pubkeyRelays.set(e.pubkey, pr);
  }

  return pubkeyRelays;
}

export function prepareRelays(
  pubkeyRelays: Map<
    string,
    {
      writeRelays: string[];
      readRelays: string[];
    }
  >,
  maxRelaysPerPubkey: number
  // addFallback = false
) {
  const prepare = (relays: string[], maxRelaysPerPubkey: number) => {
    // normalize
    const normal = relays
      // normalize urls
      .map((r) => normalizeRelay(r))
      // only valid ones
      .filter((u) => !!u)
      // remove bad relays and outbox
      .filter(
        (r) => !BLACKLISTED_RELAYS.includes(r!) && !OUTBOX_RELAYS.includes(r!)
      ) as string[];

    // dedup
    const uniq = [...new Set(normal)];

    // // prioritize good relays
    // const good = uniq.sort((a, b) => {
    //   const ga = GOOD_RELAYS.includes(a);
    //   const gb = GOOD_RELAYS.includes(b);
    //   if (ga == gb) return 0;
    //   return ga ? -1 : 1;
    // });

    // if (good.length > maxRelaysPerPubkey) good.length = maxRelaysPerPubkey;

    // if (addFallback) good.push(...FALLBACK_RELAYS);

    return uniq;
  };

  // sanitize and prioritize per pubkey
  for (const rs of pubkeyRelays.values()) {
    rs.readRelays = prepare(rs.readRelays, maxRelaysPerPubkey);
    rs.writeRelays = prepare(rs.writeRelays, maxRelaysPerPubkey);

    // NOTE: some people mistakenly mark all relays as write/read
    if (!rs.readRelays.length) rs.readRelays = rs.writeRelays;
    if (!rs.writeRelays.length) rs.writeRelays = rs.readRelays;
  }

  // merge and dedup all write/read relays
  return {
    write: [
      ...new Set([...pubkeyRelays.values()].map((pr) => pr.writeRelays).flat()),
    ],
    read: [
      ...new Set([...pubkeyRelays.values()].map((pr) => pr.readRelays).flat()),
    ],
  };
}

export async function fetchRelays(
  pubkeys: string[],
  agent?: SocksProxyAgent,
  maxRelaysPerPubkey: number = 10
) {
  const events = await fetchFromRelays(
    {
      kinds: [KIND_CONTACTS, KIND_RELAYS],
      authors: pubkeys,
    },
    OUTBOX_RELAYS,
    agent,
    10000
  );
  const pubkeyRelays = parseRelayEvents(events);

  // console.log("relays", events, pubkeyRelays);

  const relays = prepareRelays(pubkeyRelays, maxRelaysPerPubkey); // addFallback
  return {
    ...relays,
    // return all events too to let client cache them
    events: [...events],
  };
}

export async function fetchOutboxRelays(
  pubkeys: string[],
  agent?: SocksProxyAgent
) {
  return (await fetchRelays(pubkeys, agent)).write;
}
