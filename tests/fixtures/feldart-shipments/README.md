# Feldart shipment email fixtures

Real .eml samples from the Feldart fulfillment center, used by the
B2B invoicing parser tests in week 4.

## Source

Sender: Feldart, notifications@secure-wms.com (delivered via Amazon SES)

User has confirmed emails always arrive in this exact format.

## Extractable fields

- **PO Number** — e.g. "SHOP18301", strip "SHOP" prefix to get the Shopify order number
- **Transaction Number** — Feldart internal, e.g. "99863"
- **End-customer name** — between "to your customer" and "via {Carrier}"
- **Carrier (long)** — in body paragraph, e.g. "United Parcel Service"
- **Carrier (short)** — after "Carrier:" label, e.g. "UPS"
- **Tracking Number** — after "Tracking Number:" label
- **Ship Date** — US M/D/YYYY format, after "Ship Date:" label
- **Shipping Cost** — may be empty
- **Line items** — HTML table with Item / Quantity columns; each row is a SKU + decimal qty
- Zero qty signals split shipment, propose remove from QBO invoice

## Parser strategy

- Filter Gmail polling on sender notifications@secure-wms.com plus subject "requested transaction notification"
- Body is base64-encoded HTML; decode then parse with regex + simple HTML extraction
- Format is templated and stable; regex parser is sufficient
- Fall back to Claude tool-use only if regex misses any required field

## Samples

- sample-1-ups-single-item.eml — UPS, 1 line item, order SHOP18301

## TODO: more samples to confirm consistency

Would benefit from additional samples covering different carriers (FedEx,
USPS), multi-line orders, zero-quantity rows, non-empty Shipping Cost, and
edge cases in customer names. Add as sample-N-{carrier}-{description}.eml.
