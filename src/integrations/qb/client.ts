// QuickBooks Online API client.
//
// Ported from `dashboard/sync-engine.js` (1.0). Differences in 2.0:
//   - Tokens read from `oauth_tokens` (encrypted) instead of qb-tokens.json
//   - Class wraps axios + intuit-oauth, no EventEmitter
//   - 401 → forced-refresh → single retry preserved
//   - getRecentTransactions still batches Payments + Invoices + CreditMemos
//   - All Monday.com calls (getMondayBoardData, updateMondayItem) DROPPED
//   - All Cyc-aware fuzzy matching DROPPED (sync.ts owns customer matching now)

import axios, { type AxiosError, type AxiosInstance } from "axios";
import OAuthClient from "intuit-oauth";
import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";
import {
  loadQbTokens,
  refreshIfNeeded,
  saveQbTokens,
  type QbTokens,
} from "./tokens.js";
import type {
  CustomerTransactions,
  OpenInvoice,
  QboCreditMemo,
  QboCustomer,
  QboInvoice,
  QboItem,
  QboPayment,
  QboQueryResponse,
  QboTerm,
} from "./types.js";

const log = createLogger({ component: "qb-client" });

const QBO_PROD = "https://quickbooks.api.intuit.com";
const QBO_SANDBOX = "https://sandbox-quickbooks.api.intuit.com";
const QBO_MINOR_VERSION = 65;
const PAGE_SIZE = 1000;

type QboEnvironment = "sandbox" | "production";

export type QboClientConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  realmId: string;
  environment?: QboEnvironment;
};

export function configFromEnv(): QboClientConfig {
  return {
    clientId: env.QB_CLIENT_ID,
    clientSecret: env.QB_CLIENT_SECRET,
    redirectUri: env.QB_REDIRECT_URI,
    realmId: env.QB_REALM_ID,
    environment: "production",
  };
}

export class QboClient {
  private readonly oauth: OAuthClient;
  private readonly http: AxiosInstance;
  private readonly baseUrl: string;
  private readonly config: Required<QboClientConfig>;

  constructor(config: QboClientConfig = configFromEnv()) {
    this.config = {
      environment: "production",
      ...config,
    };
    this.oauth = new OAuthClient({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      environment: this.config.environment,
      redirectUri: this.config.redirectUri,
    });
    this.baseUrl =
      this.config.environment === "sandbox" ? QBO_SANDBOX : QBO_PROD;
    this.http = axios.create({ timeout: 30_000 });
  }

  // Loads tokens from DB, refreshes if expiring soon, returns the live
  // access token. Idempotent: safe to call before every request.
  private async getAccessToken(): Promise<string> {
    const tokens = await refreshIfNeeded(this.config.realmId, (current) =>
      this.performRefresh(current),
    );
    return tokens.accessToken;
  }

  // Calls intuit-oauth's refresh endpoint and returns a fresh QbTokens.
  // Wrapped so tokens.ts doesn't need to know about intuit-oauth.
  private async performRefresh(current: QbTokens): Promise<QbTokens> {
    this.oauth.setToken({
      access_token: current.accessToken,
      refresh_token: current.refreshToken,
      realmId: current.realmId,
      token_type: "bearer",
      expires_in: 3600,
    });
    const result = await this.oauth.refresh();
    // result.token is typed as `Token | string`. After a successful refresh
    // it is always a Token instance — getJson() returns the raw response
    // body which is the canonical TokenData shape.
    const tokenData = result.getJson() as {
      access_token: string;
      refresh_token: string;
      expires_in?: number;
    };
    const expiresInSec = tokenData.expires_in ?? 3600;
    return {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      realmId: current.realmId,
      expiresAt: new Date(Date.now() + expiresInSec * 1000),
      scope: current.scope,
    };
  }

  // Forces a refresh ignoring the buffer (used after a 401). Still goes
  // through the persistence path so other workers see the new tokens.
  private async forceRefresh(): Promise<string> {
    const current = await loadQbTokens(this.config.realmId);
    if (!current) {
      throw new Error(
        `No QB tokens found for realmId=${this.config.realmId}; reauthorize first`,
      );
    }
    log.warn({ realmId: this.config.realmId }, "forcing QB token refresh after 401");
    const next = await this.performRefresh(current);
    await saveQbTokens(next);
    return next.accessToken;
  }

  // Single QBO query call. Auto-retries once on 401 by forcing a token refresh —
  // covers the "another worker rotated the token mid-flight" race.
  private async query<T>(query: string): Promise<QboQueryResponse<T>> {
    const url = `${this.baseUrl}/v3/company/${this.config.realmId}/query`;
    const accessToken = await this.getAccessToken();

    const doRequest = async (token: string) => {
      return this.http.get<QboQueryResponse<T>>(url, {
        params: { query, minorversion: QBO_MINOR_VERSION },
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
    };

    try {
      const response = await doRequest(accessToken);
      return response.data;
    } catch (err) {
      const axiosErr = err as AxiosError;
      if (axiosErr.response?.status === 401) {
        const fresh = await this.forceRefresh();
        const response = await doRequest(fresh);
        return response.data;
      }
      throw err;
    }
  }

  // Generic paginated query — STARTPOSITION + MAXRESULTS pattern from 1.0.
  private async queryAll<T>(
    selectFromWhere: string,
    extractor: (r: QboQueryResponse<T>) => T[] | undefined,
  ): Promise<T[]> {
    const all: T[] = [];
    let offset = 1;
    while (true) {
      const q = `${selectFromWhere} STARTPOSITION ${offset} MAXRESULTS ${PAGE_SIZE}`;
      const data = await this.query<T>(q);
      const page = extractor(data) ?? [];
      all.push(...page);
      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
    return all;
  }

  // -------- Public API methods (port of 1.0 sync-engine.js) --------

  async getCustomers(): Promise<QboCustomer[]> {
    return this.queryAll<QboCustomer>(
      "SELECT * FROM Customer",
      (r) => r.QueryResponse.Customer,
    );
  }

  async getCustomerById(qbCustomerId: string): Promise<QboCustomer | null> {
    const data = await this.query<QboCustomer>(
      `SELECT * FROM Customer WHERE Id = '${escapeQboLiteral(qbCustomerId)}'`,
    );
    return data.QueryResponse.Customer?.[0] ?? null;
  }

  async getInvoices(): Promise<QboInvoice[]> {
    return this.queryAll<QboInvoice>(
      "SELECT * FROM Invoice",
      (r) => r.QueryResponse.Invoice,
    );
  }

  async getPayments(): Promise<QboPayment[]> {
    return this.queryAll<QboPayment>(
      "SELECT * FROM Payment",
      (r) => r.QueryResponse.Payment,
    );
  }

  async getCreditMemos(): Promise<QboCreditMemo[]> {
    return this.queryAll<QboCreditMemo>(
      "SELECT * FROM CreditMemo",
      (r) => r.QueryResponse.CreditMemo,
    );
  }

  // Open invoices = Balance > 0. Used by overdue calculation + chase logic.
  // 1.0's `getOpenInvoices(customerId?)` — keep the optional customer scope.
  async getOpenInvoices(customerId?: string): Promise<Record<string, OpenInvoice[]>> {
    const where = customerId
      ? `Balance > '0' AND CustomerRef = '${escapeQboLiteral(customerId)}'`
      : `Balance > '0'`;
    const invoices = await this.queryAll<QboInvoice>(
      `SELECT * FROM Invoice WHERE ${where}`,
      (r) => r.QueryResponse.Invoice,
    );

    const byCustomer: Record<string, OpenInvoice[]> = {};
    for (const inv of invoices) {
      const custId = inv.CustomerRef?.value;
      if (!custId) continue;
      if (!byCustomer[custId]) byCustomer[custId] = [];
      byCustomer[custId].push({
        date: inv.TxnDate ?? null,
        amount: inv.TotalAmt ?? 0,
        balance: inv.Balance ?? 0,
        docNumber: inv.DocNumber ?? null,
        dueDate: inv.DueDate ?? null,
        qbInvoiceId: inv.Id,
      });
    }

    // Sort ascending — oldest unpaid first (matches 1.0 contract).
    for (const custId of Object.keys(byCustomer)) {
      byCustomer[custId]!.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
    }
    return byCustomer;
  }

  // Recent transactions in bulk (3 calls instead of 2 per customer).
  // Returns map keyed by QBO customer Id, sorted descending by date.
  async getRecentTransactions(
    lookbackDays = 90,
  ): Promise<Record<string, CustomerTransactions>> {
    const cutoff = isoDate(daysAgo(lookbackDays));

    const [payments, invoices, creditMemos] = await Promise.all([
      this.queryAll<QboPayment>(
        `SELECT * FROM Payment WHERE TxnDate >= '${cutoff}'`,
        (r) => r.QueryResponse.Payment,
      ),
      this.queryAll<QboInvoice>(
        `SELECT * FROM Invoice WHERE TxnDate >= '${cutoff}'`,
        (r) => r.QueryResponse.Invoice,
      ),
      this.queryAll<QboCreditMemo>(
        `SELECT * FROM CreditMemo WHERE TxnDate >= '${cutoff}'`,
        (r) => r.QueryResponse.CreditMemo,
      ),
    ]);

    const byCustomer: Record<string, CustomerTransactions> = {};
    const ensure = (custId: string): CustomerTransactions => {
      if (!byCustomer[custId]) {
        byCustomer[custId] = { payments: [], invoices: [], creditMemos: [] };
      }
      return byCustomer[custId];
    };

    for (const p of payments) {
      const custId = p.CustomerRef?.value;
      if (!custId) continue;
      ensure(custId).payments.push({
        date: p.TxnDate ?? null,
        amount: p.TotalAmt ?? 0,
        docNumber: p.DocNumber ?? null,
      });
    }
    for (const inv of invoices) {
      const custId = inv.CustomerRef?.value;
      if (!custId) continue;
      ensure(custId).invoices.push({
        date: inv.TxnDate ?? null,
        amount: inv.TotalAmt ?? 0,
        balance: inv.Balance ?? 0,
        docNumber: inv.DocNumber ?? null,
        dueDate: inv.DueDate ?? null,
      });
    }
    for (const cm of creditMemos) {
      const custId = cm.CustomerRef?.value;
      if (!custId) continue;
      ensure(custId).creditMemos.push({
        date: cm.TxnDate ?? null,
        amount: cm.TotalAmt ?? 0,
        docNumber: cm.DocNumber ?? null,
      });
    }

    const cmpDesc = (a: { date: string | null }, b: { date: string | null }) =>
      (b.date ?? "").localeCompare(a.date ?? "");
    for (const bucket of Object.values(byCustomer)) {
      bucket.payments.sort(cmpDesc);
      bucket.invoices.sort(cmpDesc);
      bucket.creditMemos.sort(cmpDesc);
    }
    return byCustomer;
  }

  async getTerms(): Promise<QboTerm[]> {
    return this.queryAll<QboTerm>(
      "SELECT * FROM Term",
      (r) => r.QueryResponse.Term,
    );
  }

  async getInvoiceByDocNumber(docNumber: string): Promise<QboInvoice | null> {
    const data = await this.query<QboInvoice>(
      `SELECT * FROM Invoice WHERE DocNumber = '${escapeQboLiteral(docNumber)}'`,
    );
    return data.QueryResponse.Invoice?.[0] ?? null;
  }

  async getInvoiceById(invoiceId: string): Promise<QboInvoice | null> {
    const data = await this.query<QboInvoice>(
      `SELECT * FROM Invoice WHERE Id = '${escapeQboLiteral(invoiceId)}'`,
    );
    return data.QueryResponse.Invoice?.[0] ?? null;
  }

  // Sparse Invoice update. Caller passes a body with Id + SyncToken + sparse:true
  // and the fields to mutate. QBO replies with the updated Invoice (new
  // SyncToken). 401 → forced refresh → single retry, same as query().
  async updateInvoice(payload: object): Promise<QboInvoice> {
    const url = `${this.baseUrl}/v3/company/${this.config.realmId}/invoice`;
    const accessToken = await this.getAccessToken();

    const doRequest = async (token: string) => {
      return this.http.post<{ Invoice: QboInvoice }>(url, payload, {
        params: { minorversion: QBO_MINOR_VERSION },
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      });
    };

    try {
      const response = await doRequest(accessToken);
      return response.data.Invoice;
    } catch (err) {
      const axiosErr = err as AxiosError;
      if (axiosErr.response?.status === 401) {
        const fresh = await this.forceRefresh();
        const response = await doRequest(fresh);
        return response.data.Invoice;
      }
      throw err;
    }
  }

  async getQboItemBySku(sku: string): Promise<QboItem | null> {
    const data = await this.query<QboItem>(
      `SELECT * FROM Item WHERE Sku = '${escapeQboLiteral(sku)}'`,
    );
    return data.QueryResponse.Item?.[0] ?? null;
  }
}

// -------- Helpers (pure, exported for testing) --------

// Reproduces 1.0's overdue calculation: sum of balances where dueDate is in
// the past AND balance is positive. Critical that this stays correct — the
// standalone CLI (quickbooks-monday-sync.js) had a bug where it used
// `Balance > 0 ? Balance : 0` and we must NOT reintroduce that.
export function calculateOverdueBalance(
  invoices: Pick<OpenInvoice, "balance" | "dueDate">[],
): number {
  if (!invoices || invoices.length === 0) return 0;
  const today = isoDate(new Date());
  let overdue = 0;
  for (const inv of invoices) {
    if (inv.dueDate && inv.dueDate < today && inv.balance > 0) {
      overdue += inv.balance;
    }
  }
  return Math.round(overdue * 100) / 100;
}

// Already sorted ascending by getOpenInvoices, so first entry is oldest.
export function getOldestUnpaidInvoiceDate(
  invoices: Pick<OpenInvoice, "date">[],
): string | null {
  if (!invoices || invoices.length === 0) return null;
  return invoices[0]?.date ?? null;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

// QBO query strings are single-quoted; literal apostrophes must be doubled.
// Defensive — most IDs/SKUs won't contain apostrophes, but a bad SKU would
// silently malform the query without this.
function escapeQboLiteral(value: string): string {
  return value.replace(/'/g, "''");
}
