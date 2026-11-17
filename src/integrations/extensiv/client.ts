// Extensiv (Blue Chip's WMS, 3PL Central REST API). READ-ONLY.
//
// Finance only reads orders, to show what the warehouse billed us to ship
// each shipment on Invoicing Today. Auth is the client-credentials "app"
// token (client id/secret + TPL guid). A user_login_id is deliberately NOT
// supported here: that is what unlocks order writes, and finance must not
// have that power.
//
// Shipment emails give a Transaction Number (e.g. "120003"), which is the
// Extensiv order id (readOnly.orderId), so one RQL `in=` query fetches a
// whole page of Today rows at once.

import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "extensiv" });

const AUTH_URL = "https://secure-wms.com/AuthServer/api/Token";
const BASE = "https://secure-wms.com";
const PAGE = 100;

export type ExtensivCreds = {
  clientId: string;
  clientSecret: string;
  tplGuid: string;
};

export function credsFromEnv(): ExtensivCreds | null {
  if (!env.EXTENSIV_CLIENT_ID || !env.EXTENSIV_CLIENT_SECRET || !env.EXTENSIV_TPL_GUID) {
    return null;
  }
  return {
    clientId: env.EXTENSIV_CLIENT_ID,
    clientSecret: env.EXTENSIV_CLIENT_SECRET,
    tplGuid: env.EXTENSIV_TPL_GUID,
  };
}

// The slice of an Extensiv order we read.
export type ExtensivOrder = {
  readOnly?: { orderId?: number };
  referenceNum?: string | null;
  billing?: {
    billingCharges?: Array<{
      chargeType?: number;
      subtotal?: number;
      details?: Array<{
        chargeLabel?: string | null;
        numUnits?: number;
        chargePerUnit?: number;
        unitDescription?: string | null;
      }>;
    }>;
  } | null;
  // JSON string from the rate-shopping step (ShipEngine): carrier service +
  // the carrier's own rate, before Blue Chip's markup.
  parcelOption?: { chosenRate?: string | null } | null;
};

export class ExtensivError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ExtensivError";
    this.status = status;
  }
}

export class ExtensivClient {
  private token: { value: string; exp: number } | null = null;

  constructor(
    private readonly creds: ExtensivCreds,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.exp - 60_000) return this.token.value;
    const res = await this.fetchImpl(AUTH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization:
          "Basic " +
          Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString("base64"),
      },
      body: JSON.stringify({ grant_type: "client_credentials", tpl: this.creds.tplGuid }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!res.ok || !body.access_token) {
      throw new ExtensivError(res.status, `Extensiv auth failed (HTTP ${res.status})`);
    }
    this.token = {
      value: body.access_token,
      exp: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
    return body.access_token;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(BASE + path, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + (await this.getToken()),
        Accept: "application/hal+json",
      },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new ExtensivError(
        res.status,
        `Extensiv GET ${path.split("?")[0]}: HTTP ${res.status} ${text.slice(0, 200)}`,
      );
    }
    return JSON.parse(text) as T;
  }

  // Orders by Extensiv order id (= the shipment email's Transaction Number).
  // Non-numeric ids are dropped (they can't be order ids, and keeping them
  // out of the RQL string means no escaping concerns).
  async getOrdersByIds(ids: string[]): Promise<ExtensivOrder[]> {
    const clean = Array.from(new Set(ids.map((s) => s.trim()).filter((s) => /^\d{1,12}$/.test(s))));
    const out: ExtensivOrder[] = [];
    for (let i = 0; i < clean.length; i += PAGE) {
      const chunk = clean.slice(i, i + PAGE);
      const rql = encodeURIComponent(`readOnly.orderId=in=(${chunk.join(",")})`);
      const json = await this.get<{ _embedded?: Record<string, ExtensivOrder[]> }>(
        `/orders?pgsiz=${PAGE}&detail=All&rql=${rql}`,
      );
      const page = json._embedded ? Object.values(json._embedded)[0] ?? [] : [];
      out.push(...page);
    }
    log.debug({ asked: clean.length, got: out.length }, "extensiv orders by id");
    return out;
  }
}

let shared: ExtensivClient | null | undefined;

// Process-wide client so the token is reused across requests. Null when
// finance has no Extensiv credentials configured.
export function getExtensivClient(): ExtensivClient | null {
  if (shared === undefined) {
    const creds = credsFromEnv();
    shared = creds ? new ExtensivClient(creds) : null;
  }
  return shared;
}
