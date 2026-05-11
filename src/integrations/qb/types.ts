// TypeScript shapes for QuickBooks Online API responses we consume.
//
// These are intentionally narrow: only fields we actually read in client.ts and
// sync.ts. QBO returns plenty more (Active, MetaData, etc.) — leave those out
// rather than typing the whole API surface.

export type QboReference = {
  value: string;
  name?: string;
};

export type QboEmailAddr = {
  Address?: string;
};

export type QboPhone = {
  FreeFormNumber?: string;
};

export type QboAddress = {
  Line1?: string;
  Line2?: string;
  City?: string;
  CountrySubDivisionCode?: string;
  PostalCode?: string;
  Country?: string;
};

export type QboCustomer = {
  Id: string;
  DisplayName: string;
  CompanyName?: string;
  Active?: boolean;
  Balance?: number;
  PrimaryEmailAddr?: QboEmailAddr;
  PrimaryPhone?: QboPhone;
  BillAddr?: QboAddress;
  ShipAddr?: QboAddress;
  CurrencyRef?: QboReference;
  PaymentMethodRef?: QboReference;
  SalesTermRef?: QboReference;
  SyncToken?: string;
  MetaData?: {
    CreateTime?: string;
    LastUpdatedTime?: string;
  };
};

export type QboLineDetail = {
  ItemRef?: QboReference;
  Qty?: number;
  UnitPrice?: number;
  TaxCodeRef?: QboReference;
};

export type QboDiscountLineDetail = {
  // true → DiscountPercent is set; false → flat dollar amount in line.Amount
  PercentBased?: boolean;
  // Percentage value, e.g. 5 for 5%. Only present when PercentBased = true.
  DiscountPercent?: number;
  // Reference to a Discount item in QBO's item list (optional)
  DiscountAccountRef?: QboReference;
};

export type QboInvoiceLine = {
  Id?: string;
  LineNum?: number;
  Description?: string;
  Amount?: number;
  DetailType?: string;
  SalesItemLineDetail?: QboLineDetail;
  // Present when DetailType === "DiscountLineDetail"
  DiscountLineDetail?: QboDiscountLineDetail;
};

// Sales tax block on transactions. TotalTax is the dollar amount of tax on
// the transaction (0 when the customer/items were tax-exempt). TxnTaxCodeRef
// names the tax code QBO used — we mirror this onto credit memos so a return
// of a taxed sale recreates the same tax treatment. TaxLine[] is QBO's
// per-rate breakdown but we don't need it to mirror; TxnTaxCodeRef is enough.
export type QboTxnTaxDetail = {
  TotalTax?: number;
  TxnTaxCodeRef?: QboReference;
};

export type QboInvoice = {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  DueDate?: string;
  TotalAmt?: number;
  Balance?: number;
  CustomerRef: QboReference;
  CurrencyRef?: QboReference;
  Line?: QboInvoiceLine[];
  TxnTaxDetail?: QboTxnTaxDetail;
  EmailStatus?: string;
  PrintStatus?: string;
  SyncToken?: string;
  PrivateNote?: string;
  CustomerMemo?: { value?: string };
  CustomField?: Array<{ DefinitionId: string; Name?: string; StringValue?: string }>;
  // Per-invoice email addresses. These ARE settable on the Invoice
  // entity (unlike on Customer where only PrimaryEmailAddr exists).
  // BillEmail = TO, BillEmailCc / BillEmailBcc are comma-separated
  // multi-address strings.
  BillEmail?: QboEmailAddr;
  BillEmailCc?: QboEmailAddr;
  BillEmailBcc?: QboEmailAddr;
  MetaData?: {
    CreateTime?: string;
    LastUpdatedTime?: string;
  };
};

// SalesReceipt — Shopify-pipeline orders that are paid upfront land
// in QBO as SalesReceipts (not Invoices) since there's no AR balance
// to track. Same per-document email fields, same Line array, same
// /send endpoint. Distinguishing field on the wire is the entity
// name in the query response (Invoice vs SalesReceipt).
export type QboSalesReceipt = {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  TotalAmt?: number;
  // SalesReceipts have no AR balance — paid at creation. Field is
  // documented but typically 0; we keep the slot for shape parity
  // with Invoice in the UI layer.
  Balance?: number;
  CustomerRef: QboReference;
  CurrencyRef?: QboReference;
  Line?: QboInvoiceLine[];
  EmailStatus?: string;
  PrintStatus?: string;
  SyncToken?: string;
  PrivateNote?: string;
  CustomerMemo?: { value?: string };
  BillEmail?: QboEmailAddr;
  BillEmailCc?: QboEmailAddr;
  BillEmailBcc?: QboEmailAddr;
  MetaData?: {
    CreateTime?: string;
    LastUpdatedTime?: string;
  };
};

export type QboPayment = {
  Id: string;
  TxnDate?: string;
  TotalAmt?: number;
  DocNumber?: string;
  CustomerRef: QboReference;
  CurrencyRef?: QboReference;
  PaymentMethodRef?: QboReference;
  SyncToken?: string;
};

export type QboCreditMemo = {
  Id: string;
  TxnDate?: string;
  TotalAmt?: number;
  // Unapplied amount — decreases as the credit memo is applied to
  // invoices. 0 once fully consumed.
  Balance?: number;
  DocNumber?: string;
  CustomerRef: QboReference;
  CurrencyRef?: QboReference;
  SyncToken?: string;
  EmailStatus?: string;
  BillEmail?: QboEmailAddr;
  BillEmailCc?: QboEmailAddr;
  BillEmailBcc?: QboEmailAddr;
  CustomerMemo?: { value?: string };
  PrivateNote?: string;
};

export type QboTerm = {
  Id: string;
  Name: string;
  Active?: boolean;
  Type?: string;
  DueDays?: number;
  DiscountDays?: number;
  DiscountPercent?: number;
};

export type QboItem = {
  Id: string;
  Name: string;
  Sku?: string;
  Active?: boolean;
  UnitPrice?: number;
  Type?: string;
};

export type QboQueryResponse<T> = {
  QueryResponse: {
    Customer?: T[];
    Invoice?: T[];
    SalesReceipt?: T[];
    Payment?: T[];
    CreditMemo?: T[];
    Term?: T[];
    Item?: T[];
    startPosition?: number;
    maxResults?: number;
    totalCount?: number;
  };
  time?: string;
};

// Normalized open-invoice shape used by overdue calculation + chase logic.
// 1.0's calculateOverdueBalance compared `inv.dueDate < today && inv.balance > 0`
// against this shape; keep field names compatible.
export type OpenInvoice = {
  date: string | null;
  amount: number;
  balance: number;
  docNumber: string | null;
  dueDate: string | null;
  qbInvoiceId: string;
};

export type CustomerTransactions = {
  payments: Array<{ date: string | null; amount: number; docNumber: string | null }>;
  invoices: Array<{
    date: string | null;
    amount: number;
    balance: number;
    docNumber: string | null;
    dueDate: string | null;
  }>;
  creditMemos: Array<{ date: string | null; amount: number; docNumber: string | null }>;
};
