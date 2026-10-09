import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { Context } from "hono";
import { approveVersion, createScript, getScript, requestChanges, ReviewError, submitVersion } from "./reviews.ts";

async function readBody(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ReviewError("corpo deve ser um objeto JSON", 400);
  }
  return body as Record<string, unknown>;
}

function requiredText(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) throw new ReviewError(`${field} é obrigatório`, 400);
  return value.trim();
}

function versionNumber(value: string): number {
  const number = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(number)) {
    throw new ReviewError("número da versão inválido", 400);
  }
  return number;
}

export function createApp(db: DatabaseSync, now: () => Date = () => new Date()) {
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof ReviewError) return c.json({ error: error.message }, error.status);
    console.error(error);
    return c.json({ error: "erro interno" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/scripts", async (c) => {
    const body = await readBody(c);
    const script = createScript(db, {
      campaign_id: requiredText(body, "campaign_id"),
      creator_id: requiredText(body, "creator_id"),
      content: requiredText(body, "content"),
    }, now());
    return c.json(script, 201);
  });

  app.get("/scripts/:id", (c) => c.json(getScript(db, c.req.param("id"), now())));

  app.post("/scripts/:id/versions", async (c) => {
    const body = await readBody(c);
    return c.json(submitVersion(db, c.req.param("id"), requiredText(body, "content"), now()), 201);
  });

  app.post("/scripts/:id/versions/:number/change-request", async (c) => {
    const body = await readBody(c);
    const script = requestChanges(db, c.req.param("id"), versionNumber(c.req.param("number")), {
      reason: requiredText(body, "reason"),
      deadline_date: requiredText(body, "deadline_date"),
    }, now());
    return c.json(script);
  });

  app.post("/scripts/:id/versions/:number/approve", (c) => {
    return c.json(approveVersion(db, c.req.param("id"), versionNumber(c.req.param("number")), now()));
  });

  return app;
}
