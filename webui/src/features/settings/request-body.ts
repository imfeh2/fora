import type { HistoryValue } from "@/lib/backend";

type RequestBodyResult =
  | { value: Record<string, HistoryValue>; error: null }
  | { value: null; error: string };

const clientFields = new Set([
  "apikey",
  "authorization",
  "accesstoken",
  "refreshtoken",
  "bearertoken",
  "credentials",
  "credential",
  "password",
  "secretkey",
  "headers",
  "extraheaders",
  "extraquery",
  "baseurl",
  "httpoptions",
  "httpclient",
  "timeout",
  "maxretries",
  "proto",
  "prototype",
  "constructor",
]);
const protocolFields = new Set([
  "model",
  "modelname",
  "messages",
  "input",
  "prompt",
  "instructions",
  "system",
  "contents",
  "systeminstruction",
  "tools",
  "toolchoice",
  "functions",
  "functioncall",
  "paralleltoolcalls",
  "stream",
  "streamoptions",
  "responseformat",
  "outputformat",
  "text",
  "modalities",
  "audio",
  "n",
  "conversation",
  "previousresponseid",
  "store",
  "background",
  "include",
  "truncation",
  "contextmanagement",
  "mcpservers",
  "container",
  "cachecontrol",
  "cachedcontent",
  "promptcachekey",
  "promptcacheretention",
  "promptcacheoptions",
  "extrabody",
]);

function hasField(value: object, key: string): boolean {
  return Object.getOwnPropertyDescriptor(value, key) !== undefined;
}

function normalized(key: string): string {
  return key.replace(/[_\-\s]/g, "").toLowerCase();
}

function object(value: unknown): value is Record<string, HistoryValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validUnicode(value: string): boolean {
  return Array.from(value).every((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code < 0xd800 || code > 0xdfff);
  });
}

function positiveInteger(value: HistoryValue | undefined): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function parseRequestBody(
  text: string,
  apiType: string,
): RequestBodyResult {
  const fail = (error: string): RequestBodyResult => ({ value: null, error });
  if (new TextEncoder().encode(text).length > 16384)
    return fail("Use at most 16 KiB of UTF-8 JSON.");
  let value: unknown;
  try {
    value = text.trim() ? JSON.parse(text) : {};
  } catch {
    return fail("Enter valid JSON.");
  }
  if (!object(value)) return fail("Enter a JSON object.");
  const pending: { value: HistoryValue; depth: number; path: string }[] = [
    { value, depth: 1, path: "$" },
  ];
  while (pending.length) {
    const entry = pending.pop();
    if (!entry) throw new Error("Request body validation entry is missing");
    const { value: current, depth, path } = entry;
    if (current !== null && typeof current === "object") {
      if (depth > 16) return fail("Use at most 16 container levels.");
      for (const [key, item] of Object.entries(current)) {
        const child = `${path}.${key.slice(0, 64)}`.slice(0, 160);
        if (!Array.isArray(current)) {
          if (!validUnicode(key)) return fail("Use valid Unicode field names.");
          if (clientFields.has(normalized(key)))
            return fail(`${child}: Remove this protected client field.`);
          if (depth === 1) {
            if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key))
              return fail(
                `${child}: Use a letter followed by up to 63 letters, numbers or underscores.`,
              );
            if (protocolFields.has(normalized(key)))
              return fail(`${child}: Remove this protected protocol field.`);
          }
        }
        pending.push({ value: item, depth: depth + 1, path: child });
      }
    } else if (typeof current === "number" && !Number.isFinite(current)) {
      return fail(`${path}: Numbers must be finite.`);
    } else if (typeof current === "string" && !validUnicode(current)) {
      return fail(`${path}: Use valid Unicode text.`);
    }
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > 16384)
    return fail("Use at most 16 KiB of UTF-8 JSON.");
  if (apiType === "google" && Object.keys(value).length)
    return fail(
      "This API does not support a custom request body. Clear it before saving.",
    );
  const incompatible: Record<string, string[]> = {
    "openai-chat": ["max_output_tokens"],
    "openai-responses": [
      "reasoning_effort",
      "max_completion_tokens",
      "max_tokens",
    ],
    anthropic: [
      "reasoning_effort",
      "reasoning",
      "max_completion_tokens",
      "max_output_tokens",
    ],
    google: [],
  };
  for (const key of incompatible[apiType] ?? []) {
    if (hasField(value, key))
      return fail(`$.${key}: Remove this field for the selected API.`);
  }
  for (const key of [
    "max_tokens",
    "max_completion_tokens",
    "max_output_tokens",
  ]) {
    if (hasField(value, key) && !positiveInteger(value[key]))
      return fail(`$.${key}: Enter a positive whole number.`);
  }
  if (hasField(value, "max_tokens") && hasField(value, "max_completion_tokens"))
    return fail("Use one token limit field.");
  if (
    apiType === "openai-chat" &&
    hasField(value, "reasoning_effort") &&
    typeof value.reasoning_effort !== "string"
  )
    return fail("$.reasoning_effort: Enter a string.");
  if (apiType === "openai-responses" && hasField(value, "reasoning")) {
    if (!object(value.reasoning)) return fail("$.reasoning: Enter an object.");
    if (
      hasField(value.reasoning, "effort") &&
      typeof value.reasoning.effort !== "string"
    )
      return fail("$.reasoning.effort: Enter a string.");
  }
  if (apiType === "anthropic") {
    if (hasField(value, "thinking")) {
      if (
        !object(value.thinking) ||
        !["enabled", "adaptive", "disabled"].includes(
          String(value.thinking.type),
        )
      )
        return fail(
          "$.thinking: Enter an object with type enabled, adaptive or disabled.",
        );
      if (
        value.thinking.type === "enabled" &&
        !positiveInteger(value.thinking.budget_tokens)
      )
        return fail("$.thinking.budget_tokens: Enter a positive whole number.");
    }
    if (hasField(value, "output_config")) {
      if (!object(value.output_config))
        return fail("$.output_config: Enter an object.");
      if (
        Object.keys(value.output_config).some(
          (key) => normalized(key) === "format",
        )
      )
        return fail(
          "$.output_config.format: Remove this protected output field.",
        );
      if (
        hasField(value.output_config, "effort") &&
        typeof value.output_config.effort !== "string"
      )
        return fail("$.output_config.effort: Enter a string.");
    }
  }
  return { value, error: null };
}
