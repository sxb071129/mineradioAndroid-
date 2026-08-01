import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const pipelineSource = await readFile(
  new URL("public/classic/cover-pipeline.js", root),
  "utf8",
);

test("Classic wires readable artwork before its Emily visual runtime", async () => {
  const html = await readFile(new URL("public/classic/index.html", root), "utf8");

  assert.match(html, /<script src="cover-pipeline\.js\?v=20260801-v1"><\/script>/);
  assert.ok(
    html.indexOf('src="cover-pipeline.js?v=20260801-v1"')
      < html.indexOf('src="sonic-terrain.js?'),
  );
  assert.match(html, /pipeline\.loadReadableImage\(\[proxiedUrl, directUrl\]/);
  assert.match(html, /setAlbumBackground\(displaySrc\)/);
  assert.match(html, /Emily's cover texture and palette must not wait for edge\/depth generation/);
  assert.match(html, /pipeline\.loadReadableImage\(\[proxiedUrl, directUrl\], \{ timeoutMs: 12000 \}\)/);
  assert.match(html, /clearCurrentCoverVisuals\(opts\);\s*\}, 20000\)/);
  assert.match(html, /lyricTextPaletteFromHsl\(hsl, avgL, Math\.max\(0, best\.chroma\)\)/);
});

function createHarness(responses) {
  const requests = [];
  const revoked = [];
  let objectUrlSerial = 0;

  class MockImage {
    constructor() {
      this.naturalWidth = 640;
      this.naturalHeight = 640;
      this.width = 640;
      this.height = 640;
    }

    set src(value) {
      this.currentSrc = value;
      queueMicrotask(() => this.onload?.());
    }
  }

  const window = {};
  const context = vm.createContext({
    AbortController,
    Blob,
    Image: MockImage,
    Object,
    Promise,
    URL: {
      createObjectURL() {
        objectUrlSerial += 1;
        return `blob:cover-${objectUrlSerial}`;
      },
      revokeObjectURL(value) {
        revoked.push(value);
      },
    },
    clearTimeout,
    fetch: async (url, options) => {
      requests.push({ url, options });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return {
        ok: response.ok ?? true,
        type: response.type ?? "basic",
        headers: {
          get(name) {
            return name.toLowerCase() === "content-type" ? response.contentType : null;
          },
        },
        async blob() {
          return new Blob([response.body ?? "cover"], { type: response.contentType });
        },
      };
    },
    queueMicrotask,
    setTimeout,
    window,
  });
  vm.runInContext(pipelineSource, context);
  return { pipeline: window.MineradioCoverPipeline, requests, revoked };
}

test("Classic cover pipeline converts the proxied response to a readable object URL", async () => {
  const harness = createHarness([
    { contentType: "image/jpeg", body: "proxied-cover" },
  ]);

  const result = await harness.pipeline.loadReadableImage([
    "http://192.168.31.144:8790/api/cover?url=encoded",
    "https://images.example.test/cover.jpg",
  ]);

  assert.equal(result.source, "http://192.168.31.144:8790/api/cover?url=encoded");
  assert.equal(result.image.currentSrc, "blob:cover-1");
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].options.mode, "cors");
  assert.equal(harness.requests[0].options.credentials, "omit");
  result.release();
  assert.deepEqual(harness.revoked, ["blob:cover-1"]);
});

test("Classic cover pipeline rejects an HTML proxy fallback and tries the CORS artwork", async () => {
  const harness = createHarness([
    { contentType: "text/html", body: "not an image" },
    { contentType: "image/webp", body: "direct-cover" },
  ]);

  const result = await harness.pipeline.loadReadableImage([
    "https://player.example.test/api/cover?url=encoded",
    "https://images.example.test/cover.webp",
  ]);

  assert.equal(result.source, "https://images.example.test/cover.webp");
  assert.deepEqual(
    harness.requests.map((request) => request.url),
    [
      "https://player.example.test/api/cover?url=encoded",
      "https://images.example.test/cover.webp",
    ],
  );
  result.release();
});
