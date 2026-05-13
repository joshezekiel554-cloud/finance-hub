// Pinned SMS compose box for the Calls & SMS tab.

import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { Button } from "./ui/button";
import { Select } from "./ui/select";
import { cn } from "../lib/cn";

const SMS_MAX_LEN = 1600;

type AdditionalPhone = { label: string; number: string };

type Props = {
  customerId: string;
  primaryPhone: string | null;
  additionalPhones: AdditionalPhone[] | null;
  onSent?: () => void;
};

type SendResponse = { id: string };
type SendError = { error?: string; retryAfter?: number };

export function SmsComposeBox({
  customerId,
  primaryPhone,
  additionalPhones,
  onSent,
}: Props) {
  // Build the phone-number picker options. Primary first (if present),
  // then any labelled additional numbers. De-dupe by normalised number
  // so a primary that's also in additionalPhones doesn't show twice.
  const options = useMemo(() => {
    const list: { value: string; label: string }[] = [];
    const seen = new Set<string>();
    if (primaryPhone) {
      const key = primaryPhone.trim();
      if (key) {
        seen.add(key);
        list.push({ value: key, label: `${key} (primary)` });
      }
    }
    for (const p of additionalPhones ?? []) {
      const key = p.number.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      list.push({ value: key, label: `${key} (${p.label})` });
    }
    return list;
  }, [primaryPhone, additionalPhones]);

  const [toNumber, setToNumber] = useState<string>(() => options[0]?.value ?? "");
  const [body, setBody] = useState("");

  // Reset the picker when the customer changes or their phone list reloads.
  // Without this, navigating from customer A to customer B would leave
  // toNumber pointed at A's primary phone (which isn't in B's options) and
  // render a blank select.
  useEffect(() => {
    setToNumber(options[0]?.value ?? "");
  }, [customerId, options]);

  const sendMutation = useMutation<
    SendResponse,
    Error,
    { toNumber: string; body: string }
  >({
    mutationFn: async (input) => {
      const res = await fetch(`/api/vocatech/customers/${customerId}/sms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const errJson = (await res.json().catch(() => ({}))) as SendError;
        // Friendly message for the expected dev-env missing-config case.
        // Server returns this literal phrase from the 500 path; match on it
        // so we don't leak the raw message and the operator gets a clear
        // hint about what's missing.
        if (
          res.status === 500 &&
          (errJson.error ?? "").includes("VOCATECH_FROM_NUMBER")
        ) {
          throw new Error(
            "Outbound SMS isn't configured yet. Set VOCATECH_FROM_NUMBER in .env.",
          );
        }
        if (res.status === 429) {
          const ra = errJson.retryAfter;
          throw new Error(
            ra
              ? `Rate-limited by Vocatech. Try again in ${ra}s.`
              : "Rate-limited by Vocatech. Try again shortly.",
          );
        }
        throw new Error(errJson.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<SendResponse>;
    },
    onSuccess: () => {
      setBody("");
      onSent?.();
    },
  });

  const canSend =
    !sendMutation.isPending &&
    toNumber.trim().length > 0 &&
    body.trim().length > 0 &&
    body.length <= SMS_MAX_LEN;

  function handleSend() {
    if (!canSend) return;
    sendMutation.mutate({ toNumber, body });
  }

  if (options.length === 0) {
    return (
      <div className="border-t border-default bg-elevated px-3 py-3 text-sm text-muted">
        Customer has no phone number on file — add one in QuickBooks before
        sending SMS.
      </div>
    );
  }

  return (
    <div className="border-t border-default bg-elevated px-3 py-3">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">To</span>
          <div className="min-w-[16rem]">
            <Select
              value={toNumber}
              onChange={(e) => setToNumber(e.target.value)}
              disabled={sendMutation.isPending}
            >
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
          <span className="ml-auto text-xs text-muted">
            {body.length}/{SMS_MAX_LEN}
          </span>
        </div>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value.slice(0, SMS_MAX_LEN))}
          placeholder="Type your message…"
          aria-label="SMS message body"
          rows={3}
          disabled={sendMutation.isPending}
          className={cn(
            "w-full resize-y rounded-md border border-default bg-base px-3 py-2 text-sm text-primary",
            "placeholder:text-muted",
            "focus:outline-none focus:ring-2 focus:ring-accent-primary/40",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
        />
        <div className="flex items-center justify-between gap-2">
          <div className="min-h-[1rem] flex-1 text-xs">
            {sendMutation.isError ? (
              <span className="text-accent-danger">
                {sendMutation.error.message}
              </span>
            ) : null}
          </div>
          <Button
            type="button"
            size="sm"
            onClick={handleSend}
            disabled={!canSend}
            loading={sendMutation.isPending}
          >
            <Send className="size-3.5" /> Send
          </Button>
        </div>
      </div>
    </div>
  );
}
