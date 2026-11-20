import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTriageServer, MODEL_TIMEOUT_MS } from "../server.mjs";

let server;
let base;

before(async () => {
  server = createTriageServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

function post(body, { raw = false } = {}) {
  return fetch(`${base}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? body : JSON.stringify(body),
  });
}

const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

test("корректная заявка: тема и черновик", async () => {
  const reply = await post({ text: "Когда будет доставка заказа?" });
  assert.equal(reply.status, 200);
  assert.deepEqual(await reply.json(), {
    status: "ready",
    topic: "delivery",
    draft: "Спасибо за обращение. Уточним детали заявки.",
  });
});

test("сбой модели: ручной разбор без черновика", async (t) => {
  for (const label of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
    await t.test(label, async () => {
      const started = Date.now();
      const reply = await post({ text: `Сколько стоит доставка? ${label}` });
      const elapsed = Date.now() - started;
      assert.equal(reply.status, 200);
      assert.deepEqual(await reply.json(), MANUAL_REVIEW);
      // имитатор при [timeout] ждёт 1200 мс, сервер должен ответить вскоре после лимита в 300 мс
      assert.ok(elapsed < MODEL_TIMEOUT_MS + 500, `ответ за ${elapsed} мс`);
    });
  }
});

test("неверный ввод: 400 invalid_input", async (t) => {
  const cases = [
    ["пустая строка", { text: "" }],
    ["только пробелы", { text: "   \n " }],
    ["нет поля text", {}],
    ["text не строка", { text: 42 }],
    ["тело null", null],
    ["тело массив", ["Где заказ?"]],
  ];
  for (const [name, body] of cases) {
    await t.test(name, async () => {
      const reply = await post(body);
      assert.equal(reply.status, 400);
      assert.deepEqual(await reply.json(), { status: "invalid_input" });
    });
  }
  await t.test("битый JSON", async () => {
    const reply = await post('{"text": "Где заказ?"', { raw: true });
    assert.equal(reply.status, 400);
    assert.deepEqual(await reply.json(), { status: "invalid_input" });
  });
});
