import type Anthropic from "@anthropic-ai/sdk";

// Wrap a system prompt string into the Anthropic `system` param as a text
// block array. Returns undefined when there's nothing to send, so the caller
// omits the system field entirely (internal builders with no voice context).
//
// CACHING DEFERRED TO WAVE B/C (intentional): the installed @anthropic-ai/sdk
// (0.30.0) only supports `cache_control` via its BETA prompt-caching API, not
// the standard `messages.create` used by the draft endpoint. Wave A's prefix
// (role + voice guide) is also below Anthropic's ~1024-token minimum cacheable
// length, so caching would not engage even if wired. Returning a block array
// (not a bare string) keeps this forward-compatible: once Waves B/C grow the
// prefix past the threshold, add `cache_control: { type: "ephemeral" }` here
// and either upgrade the SDK to a GA-caching version or switch the endpoint to
// the beta prompt-caching client.
export function toSystemParam(
  system: string,
): Anthropic.Messages.TextBlockParam[] | undefined {
  if (!system || system.trim().length === 0) return undefined;
  return [{ type: "text", text: system }];
}
