import "server-only";
import { NextResponse } from "next/server";
import { botToolCall, type BotToolPath, type BotToolRequest } from "./buildResell";
import type { ActionSpec, Method } from "./botToolsHandlers";
import type { BotToolId } from "./botTools";

const headers = { "Cache-Control": "private, no-store" };
// Each entry fixes the platform path and forwards only the fields that belong
// to that operation. The dispatcher supplies the session-owned instanceId.
const SPECS = {
  "catalog-tools": { path: "/tools", methods: ["GET", "POST", "DELETE"], query: [], fields: ["tool_id", "endpoint", "token", "authMode"] },
  websites: { path: "/sites", methods: ["GET", "POST", "PUT", "DELETE"], query: [], fields: ["action", "slug", "siteId", "domainId", "domain", "method"] },
  "china-app-status": { path: "/cn-apps", methods: ["POST"], query: [], fields: ["attempt_id"] },
  "china-apps": { path: "/cn-apps", methods: ["GET", "POST", "DELETE"], query: ["slug"], fields: ["slug", "fields"] },
} as const;

const safeCodes = new Set(["rate_limited", "busy", "not_running", "instance_unavailable", "tool_busy", "invalid_connector_config", "invalid_request", "invalid_key", "missing_fields", "already_installed", "not_installed", "needs_update", "catalog_unavailable", "site_limit_reached", "slug_taken", "invalid_slug", "domain_in_use", "domain_limit_reached", "verification_failed", "skill_not_found", "framework_mismatch", "render_not_available", "expired", "superseded"]);

export const CATALOG_ACTIONS: Record<string, Partial<Record<Method, ActionSpec>>> = {};
for (const [action, spec] of Object.entries(SPECS)) {
  const handlers: Partial<Record<Method, ActionSpec>> = {};
  for (const method of spec.methods) {
    handlers[method] = {
      tool: (action === "china-app-status" ? "china-apps" : action) as BotToolId,
      limit: { max: method === "GET" || action === "china-app-status" ? 180 : 30, windowSec: 600 },
      async run({ request, instanceId }) {
        const query: Record<string, string> = {};
        for (const key of spec.query) {
          const value = request.nextUrl.searchParams.get(key);
          if (value !== null) query[key] = value.slice(0, 500);
        }
        let json: Record<string, unknown> | undefined;
        if (method !== "GET" && !(method === "DELETE" && action === "china-apps")) {
          // Consume with a cap, including chunked bodies with no length header.
          const reader = request.body?.getReader();
          let text = "";
          let size = 0;
          const decoder = new TextDecoder();
          if (reader) for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 65_536) { await reader.cancel(); return NextResponse.json({ error: "invalid_request" }, { status: 413, headers }); }
            text += decoder.decode(value, { stream: true });
          }
          text += decoder.decode();
          let body: unknown;
          try { body = JSON.parse(text); } catch { body = null; }
          if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "invalid_request" }, { status: 400, headers });
          json = {};
          for (const key of spec.fields) if (Object.hasOwn(body, key)) json[key] = (body as Record<string, unknown>)[key];
        }
        if (action === "china-app-status") {
          if (typeof json?.attempt_id !== "string" || json.attempt_id.length > 200 || !json.attempt_id.trim()) return NextResponse.json({ error: "invalid_request" }, { status: 400, headers });
          json = { slug: "baidunetdisk", fields: { action: "status", attempt_id: json.attempt_id } };
        }
        const result = await botToolCall(instanceId, spec.path as BotToolPath, {
          method: (method === "PUT" ? "PATCH" : method) as BotToolRequest["method"], query, json, timeoutMs: 150_000,
        });
        const body = result.body as Record<string, unknown>;
        if (!result.ok) {
          const code = typeof body.error === "string" && safeCodes.has(body.error) ? body.error : "upstream_error";
          return NextResponse.json({ error: code }, { status: result.status >= 400 && result.status < 600 ? result.status : 502, headers });
        }
        // These explicit v1 contracts contain public catalog/status data only.
        // China-app connect returns its login step outside the data envelope.
        return NextResponse.json(body.data ?? ((action === "china-apps" || action === "china-app-status") ? { ok: body.ok, ready: body.ready, login: body.login } : {}), { headers });
      },
    };
  }
  CATALOG_ACTIONS[action] = handlers;
}
