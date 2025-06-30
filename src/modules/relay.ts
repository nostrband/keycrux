import { SocksProxyAgent } from "socks-proxy-agent";
import { Event, Filter, validateEvent, verifyEvent } from "nostr-tools";
import { CloseEvent, MessageEvent, WebSocket } from "ws";

const PAUSE = 3000;

export interface RelayOptions {
  relayUrl: string;
  agent: SocksProxyAgent;
}

export interface Req {
  id: string;
  filter: Filter;
  // fetch back vs subscribe for updates
  fetch: boolean;
  // used if fetch=false to re-subscribe since last update
  since?: number;
  onEvent?: (e: Event) => void;
  onClosed?: () => void;
  onEOSE?: (events: Event[]) => void;
}

export class Relay {
  private relayUrl: string;
  private agent?: SocksProxyAgent;
  private ws?: WebSocket;
  private publishing = new Map<
    string,
    { event: Event; ok: () => void; err: (e: any) => void }
  >();
  private reqs = new Map<string, { req: Req; events: Event[] }>();
  private isReconnecting = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 0;
  private intentionallyClosed = false;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(
    relayUrl: string,
    agent?: SocksProxyAgent,
    maxReconnectAttempts: number = 0
  ) {
    this.relayUrl = relayUrl;
    this.agent = agent;
    this.maxReconnectAttempts = maxReconnectAttempts;
    this.connect();
  }

  public [Symbol.dispose]() {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.ws) {
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        try {
          this.ws.close();
        } catch (err) {
          console.log("Error closing WebSocket", this.relayUrl, err);
        }
      }
      this.ws = undefined;
    }

    this.publishing.clear();
    this.reqs.clear();
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
  }

  private connect() {
    if (this.intentionallyClosed) return;

    try {
      this.isReconnecting = true;
      console.log(
        new Date(),
        "connecting to",
        this.relayUrl,
        "attempt",
        this.reconnectAttempts + 1
      );

      this.ws = new WebSocket(this.relayUrl, { agent: this.agent });
      this.ws.onopen = this.onOpen.bind(this);
      this.ws.onclose = this.onClose.bind(this);
      this.ws.onerror = this.onError.bind(this);
      this.ws.onmessage = this.onMessage.bind(this);
    } catch (err) {
      console.log("Error creating WebSocket", this.relayUrl, err);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.intentionallyClosed) return;

    this.reconnectAttempts++;
    if (
      this.maxReconnectAttempts > 0 &&
      this.reconnectAttempts > this.maxReconnectAttempts
    ) {
      console.log(
        new Date(),
        "max reconnect attempts reached for",
        this.relayUrl
      );
      return;
    }

    // Exponential backoff with jitter
    const delay =
      Math.min(PAUSE * Math.pow(1.5, this.reconnectAttempts - 1), 60000) *
      (0.8 + Math.random() * 0.4);
    console.log(
      new Date(),
      "scheduling reconnect to",
      this.relayUrl,
      "in",
      Math.round(delay),
      "ms"
    );

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private onOpen() {
    console.log(
      new Date(),
      "opened",
      this.relayUrl,
      "reqs",
      this.reqs.size,
      "publish",
      this.publishing.size
    );

    this.isReconnecting = false;
    this.reconnectAttempts = 0;

    // Re-publish pending events
    for (const { event } of this.publishing.values()) {
      this.publishEvent(event);
    }

    // Re-send subscriptions
    for (const id of this.reqs.keys()) {
      this.send(id);
    }
  }

  private onClose(e: CloseEvent) {
    console.log(
      new Date(),
      "relay closed",
      this.relayUrl,
      e.code,
      e.reason,
      e.wasClean
    );

    this.ws = undefined;

    // Don't reconnect if intentionally closed
    if (!this.intentionallyClosed) {
      this.scheduleReconnect();
    }
  }

  private onError(e: any) {
    console.log(
      new Date(),
      "relay error",
      this.relayUrl,
      e.error,
      e.message,
      e.type
    );

    // WebSocket errors often don't trigger onClose, so we need to handle reconnection here too
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.CLOSING ||
        this.ws.readyState === WebSocket.CLOSED)
    ) {
      this.ws = undefined;
      if (!this.intentionallyClosed && !this.isReconnecting) {
        this.scheduleReconnect();
      }
    }
  }

  private onMessage(e: MessageEvent) {
    try {
      const cmd = JSON.parse(e.data.toString("utf8"));
      if (!Array.isArray(cmd) || cmd.length === 0)
        throw new Error("Empty relay message");
      switch (cmd[0]) {
        case "EVENT":
          return this.onEvent(cmd);
        case "EOSE":
          return this.onEOSE(cmd);
        case "NOTICE":
          return this.onNotice(cmd);
        case "CLOSED":
          return this.onClosed(cmd);
        case "OK":
          return this.onOK(cmd);
        default:
          throw new Error("Unknown relay message");
      }
    } catch (err) {
      console.log("Bad message", this.relayUrl, err, e.data);
    }
  }

  private onEvent(cmd: any[]) {
    try {
      if (cmd.length < 3) {
        console.log("Bad EVENT command format", this.relayUrl, cmd);
        return;
      }

      const reqId = cmd[1];
      const req = this.reqs.get(reqId);
      // irrelevant
      if (!req) return;

      // verify, validate
      const event = cmd[2];
      if (!validateEvent(event)) {
        console.log("Invalid event", this.relayUrl, event);
        return;
      }

      if (!verifyEvent(event)) {
        console.log("Invalid signature", this.relayUrl, event);
        return;
      }

      // update cursor so that even after some relay issues
      // we know where we stopped the last time
      if (!req.req.fetch) req.req.since = event.created_at;

      // notify subscription
      req.events.push(event);

      try {
        req.req.onEvent?.(event);
      } catch (err) {
        console.log("Error in onEvent callback", this.relayUrl, err);
      }
    } catch (err) {
      console.log("Bad event", this.relayUrl, err, cmd);
    }
  }

  private onEOSE(cmd: any[]) {
    try {
      if (cmd.length < 2) {
        console.log("Bad EOSE format", this.relayUrl, cmd);
        return;
      }

      const reqId = cmd[1];
      const req = this.reqs.get(reqId);
      if (!req) return;

      try {
        req.req.onEOSE?.(req.events);
      } catch (err) {
        console.log("Error in onEOSE callback", this.relayUrl, err);
      }

      if (req.req.fetch) this.reqs.delete(reqId);
    } catch (err) {
      console.log("Error processing EOSE", this.relayUrl, err, cmd);
    }
  }

  private onNotice(cmd: any[]) {
    try {
      console.log("notice", this.relayUrl, cmd);
    } catch (err) {
      console.log("Error processing NOTICE", this.relayUrl, err, cmd);
    }
  }

  private onClosed(cmd: any[]) {
    try {
      console.log("closed", this.relayUrl, cmd);
      if (cmd.length < 2) {
        console.log("Bad CLOSED format", this.relayUrl, cmd);
        return;
      }

      const reqId = cmd[1];
      const req = this.reqs.get(reqId);
      if (!req) return;

      try {
        req.req.onClosed?.();
      } catch (err) {
        console.log("Error in onClosed callback", this.relayUrl, err);
      }

      // unconditionally delete the req to make sure
      // we don't keep re-sending this req, as
      // closed is generally "auth-required" thing
      // and we don't support that
      this.reqs.delete(reqId);
    } catch (err) {
      console.log("Error processing CLOSED", this.relayUrl, err, cmd);
    }
  }

  private onOK(cmd: any[]) {
    try {
      if (cmd.length < 4) {
        console.log("Bad OK command format", this.relayUrl, cmd);
        return;
      }

      const id = cmd[1];
      const cbs = this.publishing.get(id);
      if (!cbs) return;

      this.publishing.delete(id);
      console.log("publish result", this.relayUrl, cmd);

      const { ok, err } = cbs;
      try {
        if (cmd[2]) ok();
        else err("Failed to publish event");
      } catch (callbackErr) {
        console.log("Error in OK callback", this.relayUrl, callbackErr);
      }
    } catch (err) {
      console.log("Error processing OK", this.relayUrl, err, cmd);
    }
  }

  private send(id: string) {
    try {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        console.log("WebSocket not open for sending", this.relayUrl);
        return;
      }

      const req = this.reqs.get(id);
      if (!req) {
        console.log("Request not found for sending", this.relayUrl, id);
        return;
      }

      const filter = { ...req.req.filter };
      if ((req.req.since || 0) > (filter.since || 0))
        filter.since = req.req.since;

      const cmd = ["REQ", req.req.id, filter];
      console.log("req", this.relayUrl, cmd);

      try {
        this.ws.send(JSON.stringify(cmd));
      } catch (err) {
        console.log("Error sending REQ", this.relayUrl, err);
        // If we can't send, the connection might be broken
        this.reconnect();
      }
    } catch (err) {
      console.log("Error preparing REQ", this.relayUrl, err);
    }
  }

  private publishEvent(e: Event) {
    try {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        console.log("WebSocket not open for publishing", this.relayUrl);
        return;
      }

      // take only valid nostr event fields
      const { id, pubkey, created_at, kind, content, tags, sig } = e;
      const cmd = [
        "EVENT",
        { id, pubkey, created_at, kind, content, tags, sig },
      ];
      console.log("publish", this.relayUrl, cmd[1]);

      try {
        this.ws.send(JSON.stringify(cmd));
      } catch (err) {
        console.log("Error sending EVENT", this.relayUrl, err);
        // If we can't send, the connection might be broken
        this.reconnect();
      }
    } catch (err) {
      console.log("Error preparing EVENT", this.relayUrl, err);
    }
  }

  public get url() {
    return this.relayUrl;
  }

  public close(id: string) {
    try {
      if (!this.reqs.delete(id)) return;

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        console.log(
          "WebSocket not open for closing subscription",
          this.relayUrl
        );
        return;
      }

      const cmd = ["CLOSE", id];
      console.log("close", this.relayUrl, cmd);

      try {
        this.ws.send(JSON.stringify(cmd));
      } catch (err) {
        console.log("Error sending CLOSE", this.relayUrl, err);
      }
    } catch (err) {
      console.log("Error closing subscription", this.relayUrl, err);
    }
  }

  public req(req: Req) {
    if (!req.onEOSE && !req.onEvent)
      throw new Error("Specify either onEOSE or onEvent");

    this.reqs.set(req.id, { req, events: [] });

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send(req.id);
    }
  }

  public publish(e: Event, to: number = 10000) {
    return new Promise<void>(async (ok, err) => {
      try {
        // timeout handler
        const timer = setTimeout(() => {
          console.log("publish timeout", this.relayUrl, e.id);
          this.publishing.delete(e.id);
          err("Publish timeout");
        }, to);

        // handlers to process OK message
        this.publishing.set(e.id, {
          event: e,
          ok: () => {
            clearTimeout(timer);
            ok();
          },
          err: (e) => {
            clearTimeout(timer);
            err(e);
          },
        });

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          console.log("publish waiting for relay connect", this.relayUrl, e.id);
          // If we're not connected and not reconnecting, try to reconnect
          if (!this.isReconnecting && !this.intentionallyClosed) {
            this.reconnect();
          }
        } else {
          this.publishEvent(e);
        }
      } catch (error) {
        console.log("Error in publish", this.relayUrl, error);
        err("Error in publish: " + error);
      }
    });
  }

  public reconnect() {
    console.log(new Date(), "reconnect", this.relayUrl);
    this.intentionallyClosed = false;

    try {
      if (this.ws) {
        if (
          this.ws.readyState === WebSocket.OPEN ||
          this.ws.readyState === WebSocket.CONNECTING
        ) {
          try {
            this.ws.close();
          } catch (err) {
            console.log(
              "Error closing WebSocket during reconnect",
              this.relayUrl,
              err
            );
          }
        }
        this.ws = undefined;
      }

      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
      }

      this.reconnectAttempts = 0;
      this.isReconnecting = false;
      this.connect();
    } catch (err) {
      console.log("Error during reconnect", this.relayUrl, err);
      this.scheduleReconnect();
    }
  }
}
