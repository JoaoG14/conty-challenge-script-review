import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import type { getScript } from "../src/reviews.ts";

type Script = ReturnType<typeof getScript>;

describe("revisão de roteiro", () => {
  let db: DatabaseSync;
  let app: ReturnType<typeof createApp>;
  let currentTime: string;

  beforeEach(() => {
    currentTime = "2026-03-12T15:00:00.000Z";
    db = openDatabase();
    app = createApp(db, () => new Date(currentTime));
  });

  afterEach(() => db.close());

  function post(path: string, body: unknown = {}) {
    return app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function create(): Promise<Script> {
    const response = await post("/scripts", {
      campaign_id: "cmp_01",
      creator_id: "crt_01",
      content: "Apresentar o produto e mostrar como usar.",
    });
    expect(response.status).toBe(201);
    return response.json() as Promise<Script>;
  }

  async function read(id: string): Promise<Script> {
    const response = await app.request(`/scripts/${id}`);
    expect(response.status).toBe(200);
    return response.json() as Promise<Script>;
  }

  function changes(id: string, number = 1, deadline = "2026-03-12") {
    return post(`/scripts/${id}/versions/${number}/change-request`, {
      reason: "Incluir uma demonstração do produto.",
      deadline_date: deadline,
    });
  }

  it("cria a primeira versão em revisão e permite consultar o roteiro", async () => {
    const script = await create();
    expect(script).toMatchObject({
      campaign_id: "cmp_01",
      creator_id: "crt_01",
      status: "in_review",
      current_version: 1,
      created_at: currentTime,
      versions: [{
        number: 1,
        content: "Apresentar o produto e mostrar como usar.",
        status: "in_review",
        submitted_at: currentTime,
        reviewed_at: null,
        change_request: null,
      }],
    });
    expect(await read(script.id)).toEqual(script);
  });

  it("preserva o histórico durante pedido de alteração, reenvio e aprovação", async () => {
    const script = await create();
    currentTime = "2026-03-12T16:00:00.000Z";
    const requested = await changes(script.id);
    expect(requested.status).toBe(200);
    const waiting = await requested.json() as Script;
    expect(waiting.status).toBe("changes_requested");
    expect(waiting.versions[0].change_request).toEqual({
      reason: "Incluir uma demonstração do produto.",
      deadline_date: "2026-03-12",
    });
    expect(waiting.versions[0].reviewed_at).toBe(currentTime);

    currentTime = "2026-03-12T17:00:00.000Z";
    const submitted = await post(`/scripts/${script.id}/versions`, { content: "Demonstrar o produto em uso." });
    expect(submitted.status).toBe(201);
    const updated = await submitted.json() as Script;
    expect(updated.status).toBe("in_review");
    expect(updated.current_version).toBe(2);
    expect(updated.versions).toHaveLength(2);
    expect(updated.versions[0]).toEqual({ ...waiting.versions[0], status: "superseded" });
    expect(updated.versions[1].submitted_at).toBe(currentTime);

    currentTime = "2026-03-12T18:00:00.000Z";
    const approved = await post(`/scripts/${script.id}/versions/2/approve`);
    expect(approved.status).toBe(200);
    const final = await approved.json() as Script;
    expect(final.status).toBe("approved");
    expect(final.versions[1].reviewed_at).toBe(currentTime);
    expect(final.versions[0]).toEqual(updated.versions[0]);
  });

  it("aceita mais de uma rodada de revisão sem perder o conteúdo anterior", async () => {
    const script = await create();
    expect((await changes(script.id)).status).toBe(200);
    expect((await post(`/scripts/${script.id}/versions`, { content: "Segunda versão" })).status).toBe(201);
    expect((await changes(script.id, 2)).status).toBe(200);
    expect((await post(`/scripts/${script.id}/versions`, { content: "Terceira versão" })).status).toBe(201);
    const result = await read(script.id);
    expect(result.current_version).toBe(3);
    expect(result.versions.map((version) => version.status)).toEqual(["superseded", "superseded", "in_review"]);
    expect(result.versions.map((version) => version.content)).toEqual([
      script.versions[0].content, "Segunda versão", "Terceira versão",
    ]);
  });

  it("aprova a primeira versão e impede qualquer reabertura", async () => {
    const script = await create();
    expect((await post(`/scripts/${script.id}/versions/1/approve`)).status).toBe(200);
    const approved = await read(script.id);
    expect(approved.status).toBe("approved");
    expect((await post(`/scripts/${script.id}/versions`, { content: "Outra versão" })).status).toBe(409);
    expect((await changes(script.id)).status).toBe(409);
    expect((await post(`/scripts/${script.id}/versions/1/approve`)).status).toBe(409);
    expect(await read(script.id)).toEqual(approved);
  });

  it("recusa nova versão antes de a marca pedir alteração", async () => {
    const script = await create();
    expect((await post(`/scripts/${script.id}/versions`, { content: "Outra versão" })).status).toBe(409);
    expect(await read(script.id)).toEqual(script);
  });

  it("recusa aprovação e novo pedido enquanto aguarda a versão corrigida", async () => {
    const script = await create();
    await changes(script.id);
    const waiting = await read(script.id);
    expect((await post(`/scripts/${script.id}/versions/1/approve`)).status).toBe(409);
    expect((await changes(script.id, 1, "2026-03-15")).status).toBe(409);
    expect(await read(script.id)).toEqual(waiting);
  });

  it("recusa ações sobre versão antiga sem alterar a versão atual", async () => {
    const script = await create();
    await changes(script.id);
    await post(`/scripts/${script.id}/versions`, { content: "Segunda versão" });
    const before = await read(script.id);
    expect((await changes(script.id)).status).toBe(409);
    expect((await post(`/scripts/${script.id}/versions/1/approve`)).status).toBe(409);
    expect(await read(script.id)).toEqual(before);
  });

  it("aceita apenas um dos dois reenvios simultâneos", async () => {
    const script = await create();
    await changes(script.id);
    const responses = await Promise.all([
      post(`/scripts/${script.id}/versions`, { content: "Segunda versão" }),
      post(`/scripts/${script.id}/versions`, { content: "Reenvio duplicado" }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect((await read(script.id)).versions).toHaveLength(2);
  });

  it.each([
    ["sem motivo", { deadline_date: "2026-03-12" }],
    ["com motivo vazio", { reason: "  ", deadline_date: "2026-03-12" }],
    ["sem prazo", { reason: "Corrigir introdução" }],
    ["com prazo vazio", { reason: "Corrigir introdução", deadline_date: "" }],
    ["com motivo de tipo incorreto", { reason: 123, deadline_date: "2026-03-12" }],
  ])("recusa pedido de alteração %s", async (_, body) => {
    const script = await create();
    const response = await post(`/scripts/${script.id}/versions/1/change-request`, body);
    expect(response.status).toBe(400);
    expect(await read(script.id)).toEqual(script);
  });

  it.each(["2026-02-30", "2026-13-01", "2026-3-12", "2026-03-12T23:59:59-03:00"])(
    "recusa prazo inválido: %s", async (deadline) => {
      const script = await create();
      expect((await changes(script.id, 1, deadline)).status).toBe(400);
      expect(await read(script.id)).toEqual(script);
    },
  );

  it("recusa pedido de alteração com prazo que já passou", async () => {
    const script = await create();
    expect((await changes(script.id, 1, "2026-03-11")).status).toBe(409);
    expect(await read(script.id)).toEqual(script);
  });

  it.each([
    ["2026-03-13T01:02:00.000Z", 200],
    ["2026-03-13T02:59:59.999Z", 200],
    ["2026-03-13T03:00:00.000Z", 409],
  ])("valida o prazo do pedido pelo dia de São Paulo em %s", async (time, status) => {
    const script = await create();
    currentTime = time;
    expect((await changes(script.id)).status).toBe(status);
    expect((await read(script.id)).status).toBe(status === 200 ? "changes_requested" : "in_review");
  });

  it.each([
    ["2026-03-13T01:02:00.000Z", 201],
    ["2026-03-13T02:59:59.999Z", 201],
    ["2026-03-13T03:00:00.000Z", 409],
  ])("valida o prazo do reenvio pelo dia de São Paulo em %s", async (time, status) => {
    const script = await create();
    await changes(script.id);
    currentTime = time;
    const response = await post(`/scripts/${script.id}/versions`, { content: "Versão corrigida" });
    expect(response.status).toBe(status);
    const result = await read(script.id);
    expect(result.status).toBe(status === 201 ? "in_review" : "expired");
    expect(result.versions).toHaveLength(status === 201 ? 2 : 1);
  });

  it("mostra o prazo expirado sem precisar de uma escrita no banco", async () => {
    const script = await create();
    await changes(script.id);
    currentTime = "2026-03-13T03:00:00.000Z";
    const result = await read(script.id);
    expect(result.status).toBe("expired");
    expect(result.versions[0].status).toBe("expired");
    expect(result.versions[0].change_request?.deadline_date).toBe("2026-03-12");
    expect((await changes(script.id, 1, "2026-03-14")).status).toBe(409);
    expect((await post(`/scripts/${script.id}/versions/1/approve`)).status).toBe(409);
  });

  it("permite revisar depois do prazo se a nova versão foi enviada a tempo", async () => {
    const script = await create();
    await changes(script.id);
    await post(`/scripts/${script.id}/versions`, { content: "Versão corrigida" });
    currentTime = "2026-03-20T15:00:00.000Z";
    expect((await post(`/scripts/${script.id}/versions/2/approve`)).status).toBe(200);
    const result = await read(script.id);
    expect(result.status).toBe("approved");
    expect(result.versions[0].status).toBe("superseded");
  });

  it("responde 404 para roteiro ou versão inexistente", async () => {
    expect((await app.request("/scripts/missing")).status).toBe(404);
    expect((await post("/scripts/missing/versions", { content: "Roteiro" })).status).toBe(404);
    expect((await changes("missing")).status).toBe(404);
    expect((await post("/scripts/missing/versions/1/approve")).status).toBe(404);
    const script = await create();
    expect((await changes(script.id, 99)).status).toBe(404);
    expect((await post(`/scripts/${script.id}/versions/99/approve`)).status).toBe(404);
  });

  it("recusa conteúdo vazio e campos obrigatórios ausentes", async () => {
    expect((await post("/scripts", { campaign_id: "cmp_01", creator_id: "crt_01", content: "  " })).status).toBe(400);
    expect((await post("/scripts", { creator_id: "crt_01", content: "Roteiro" })).status).toBe(400);
    expect((await post("/scripts", { campaign_id: "cmp_01", content: "Roteiro" })).status).toBe(400);
    const script = await create();
    await changes(script.id);
    expect((await post(`/scripts/${script.id}/versions`, { content: " " })).status).toBe(400);
    expect((await read(script.id)).versions).toHaveLength(1);
  });

  it.each([null, [], "texto"])("recusa corpo que não é um objeto: %j", async (body) => {
    expect((await post("/scripts", body)).status).toBe(400);
  });

  it("recusa JSON malformado", async () => {
    const response = await app.request("/scripts", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{",
    });
    expect(response.status).toBe(400);
  });

  it("recusa número de versão inválido", async () => {
    const script = await create();
    expect((await post(`/scripts/${script.id}/versions/abc/approve`)).status).toBe(400);
    expect((await post(`/scripts/${script.id}/versions/0/approve`)).status).toBe(400);
  });
});
