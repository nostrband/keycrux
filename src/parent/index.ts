// @ts-ignore
import socks5 from "node-socks5-server";
import { RawData, WebSocket, WebSocketServer } from "ws";
import fs from "node:fs";
import { Event, validateEvent, verifyEvent } from "nostr-tools";
import { nsmParseAttestation } from "../modules/nsm";
import { fetchOutboxRelays } from "../modules/nostr";
import { verifyBuild, verifyInstance, verifyRelease } from "../modules/aws";

interface Req {
  id: string;
  method: string;
  params: string[];
}

interface Rep {
  id: string;
  result: string;
  error?: string;
}

class ParentServer {
  private wss: WebSocketServer;
  private dir: string;

  constructor({ port, dir = "./instance/" }: { port: number; dir?: string }) {
    this.dir = dir;
    this.wss = new WebSocketServer({ port });
    this.wss.on("connection", this.onConnect.bind(this));
  }

  private read() {
    let build: Event | undefined;
    let instance: Event | undefined;
    let releases: Event[] = [];
    try {
      build = JSON.parse(
        fs.readFileSync(this.dir + "/build.json").toString("utf8")
      );
    } catch (e) {
      console.log("No build file", e);
    }
    try {
      instance = JSON.parse(
        fs.readFileSync(this.dir + "/instance.json").toString("utf8")
      );
    } catch (e) {
      console.log("No instance file", e);
    }
    try {
      const files = fs.readdirSync(this.dir + "/release/");
      console.log("release files", files);
      for (const file of files) {
        const release = JSON.parse(
          fs.readFileSync(this.dir + "/release/" + file).toString("utf8")
        );
        releases.push(release);
      }
    } catch (e) {
      console.log("No release files", e);
    }
    console.log("build", build);
    console.log("instance", instance);
    console.log("releases", releases);
    if (build) {
      if (!validateEvent(build) || !verifyEvent(build))
        throw new Error("Invalid build.json");
    }
    if (instance) {
      if (!validateEvent(instance) || !verifyEvent(instance))
        throw new Error("Invalid instance.json");
    }
    if (releases) {
      for (const release of releases)
        if (!validateEvent(release) || !verifyEvent(release))
          throw new Error("Invalid releases");
    }

    return { build, instance, releases };
  }

  private onConnect(ws: WebSocket) {
    ws.on("error", console.error);
    const self = this;
    ws.on("message", (data) => self.onMessage(ws, data));
  }

  private async handleStart(params: string[]) {
    const att = Buffer.from(params[0], "base64");
    console.log("start att", att);

    const attData = nsmParseAttestation(att);

    const { build, instance, releases } = this.read();
    // debug enclaves return zero PCR0
    const prodEnclave = !!attData.pcrs.get(0)!.find((c) => c !== 0);
    if (prodEnclave) {
      verifyBuild(attData, build!);
      verifyInstance(attData, instance!);
      for (const release of releases) verifyRelease(attData, release);
    }

    const relays = await fetchOutboxRelays([build!.pubkey, instance!.pubkey]);
    console.log("outbox relays", build!.pubkey, instance!.pubkey, relays);

    const prod = process.env.PROD === "true";
    return JSON.stringify({
      build,
      instance,
      releases,
      instanceAnnounceRelays: relays,
      prod,
    });
  }

  private async onMessage(ws: WebSocket, data: RawData) {
    console.log("received: %s", data);
    let rep: Rep | undefined;
    try {
      const req = JSON.parse(data.toString("utf8"));
      console.log("req", req);
      rep = {
        id: req.id,
        result: "",
      };
      switch (req.method) {
        case "start":
          rep.result = await this.handleStart(req.params);
          break;
        default:
          throw new Error("Unknown method");
      }
    } catch (e: any) {
      console.log("Bad req", e, data.toString("utf8"));
      if (rep) rep.error = e.message || e.toString();
    }
    console.log("rep", rep);
    if (rep) {
      ws.send(JSON.stringify(rep));
    } else {
      ws.close();
    }
  }
}

function startParentServer(port: number) {
  new ParentServer({ port });
}

function startProxyServer(port: number) {
  console.log("starting proxy on", port);
  const server = socks5.createServer();
  return server.listen(port);
}

export async function mainParent(argv: string[]) {
  if (!argv.length) throw new Error("Service not specified");
  if (argv[0] === "run") {
    const socksPort = Number(argv?.[1]) || 1080;
    const parentPort = Number(argv?.[2]) || 2080;
    startParentServer(parentPort);
    startProxyServer(socksPort);
    return new Promise(ok => {});
  }
}
