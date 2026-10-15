import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

test("classifica os estados de conexão sem confundir disconnected com connected", async () => {
  const source = await readFile(new URL("../public/js/session-state.js", import.meta.url), "utf8");
  const context: { window: { ZapConnectSessionState?: { classify: (state: string) => string } } } = {
    window: {},
  };
  runInNewContext(source, context);

  const classify = context.window.ZapConnectSessionState!.classify;
  assert.equal(classify("DISCONNECTED"), "disconnected");
  assert.equal(classify("disconnectedMobile"), "disconnected");
  assert.equal(classify("browserClose"), "disconnected");
  assert.equal(classify("inChat"), "connected");
  assert.equal(classify("CONNECTED"), "connected");
  assert.equal(classify("qrReadSuccess"), "connecting");
  assert.equal(classify("notLogged"), "qr");
});
