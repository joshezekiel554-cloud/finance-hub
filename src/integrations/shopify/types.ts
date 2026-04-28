// Shopify Admin REST API types — only the fields the B2B invoicing
// reconciler and customer/order sync actually consume. Intentionally narrow:
// we'd rather hit a runtime error on a missing field than carry unused
// "complete" types that drift from upstream.
//
// Source: https://shopify.dev/docs/api/admin-rest/2026-01

export type Money = string; // "12.50"

export type ShopifyAddress = {
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  province_code?: string | null;
  country?: string | null;
  country_code?: string | null;
  zip?: string | null;
  phone?: string | null;
};

export type ShopifyCustomerRef = {
  id: number;
  email: string | null;
  first_name?: string | null;
  last_name?: string | null;
  default_address?: ShopifyAddress | null;
  tags?: string;
};

export type ShopifyLineItem = {
  id: number;
  product_id: number | null;
  variant_id: number | null;
  sku: string | null;
  title: string;
  variant_title?: string | null;
  quantity: number;
  // unit price as displayed in storefront currency (typically retail GBP/USD)
  price: Money;
  // running totals after discounts; useful for B2B 50% calc reconciliation
  total_discount?: Money;
  fulfillable_quantity?: number;
  fulfillment_status?: string | null;
};

// Subset of /orders endpoint payload the reconciler needs:
//  - name (e.g. "#18301") to match Feldart PO SHOP18301
//  - line_items to compare against shipped quantities + price for B2B calc
//  - customer + shipping_address to hydrate the Order record / customer match
export type ShopifyOrder = {
  id: number;
  // "#18301" — the human-readable order number Shopify shows merchants.
  name: string;
  // 18301 — bare integer form, what Feldart prefixes with SHOP.
  order_number: number;
  email: string | null;
  created_at: string;
  updated_at: string;
  processed_at: string | null;
  cancelled_at: string | null;
  closed_at: string | null;
  fulfillment_status: string | null;
  financial_status: string | null;
  currency: string;
  total_price: Money;
  subtotal_price: Money | null;
  total_tax: Money | null;
  note: string | null;
  tags: string;
  customer: ShopifyCustomerRef | null;
  shipping_address: ShopifyAddress | null;
  billing_address: ShopifyAddress | null;
  line_items: ShopifyLineItem[];
};

export type ShopifyVariant = {
  id: number;
  product_id: number;
  title: string;
  sku: string | null;
  price: Money;
  compare_at_price: Money | null;
  inventory_quantity: number | null;
};

export type ShopifyProduct = {
  id: number;
  title: string;
  vendor: string;
  product_type: string;
  status: string;
  tags: string;
  variants: ShopifyVariant[];
};

// A page returned by the cursor pager: the items plus the next-page token (or
// null at end of stream).
export type Page<T> = {
  items: T[];
  next: string | null;
};
