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

export type QboInvoiceLine = {
  Id?: string;
  LineNum?: number;
  Description?: string;
  Amount?: number;
  DetailType?: string;
  SalesItemLineDetail?: QboLineDetail;
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
  EmailStatus?: string;
  PrintStatus?: string;
  SyncToken?: string;
  PrivateNote?: string;
  CustomerMemo?: { value?: string };
  CustomField?: Array<{ DefinitionId: string; Name?: string; StringValue?: string }>;
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
  Balance?: number;
  DocNumber?: string;
  CustomerRef: QboReference;
  SyncToken?: string;
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
