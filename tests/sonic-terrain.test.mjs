import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const source = await readFile(path.join(root, "public", "classic", "sonic-terrain.js"), "utf8");

function createGradient() {
  return { addColorStop() {} };
}

function createHarness({
  width = 1200,
  height = 800,
  devicePixelRatio = 3,
  mobile = false,
  coarsePointer = false,
  reducedMotion = false,
} = {}) {
  const bodyClasses = new Set(mobile ? ["mobile-optimized"] : []);
  const canvases = [];
  const listeners = new Map();

  function createContext() {
    return {
      clearCount: 0,
      strokeCount: 0,
      points: [],
      setTransform() {},
      clearRect() { this.clearCount += 1; },
      createRadialGradient: createGradient,
      createLinearGradient: createGradient,
      fillRect() {},
      beginPath() {},
      moveTo(x, y) { this.points.push(["m", x, y]); },
      lineTo(x, y) { this.points.push(["l", x, y]); },
      stroke() { this.strokeCount += 1; },
      lineCap: "",
      lineJoin: "",
      lineWidth: 0,
      strokeStyle: "",
      fillStyle: "",
    };
  }

  const body = {
    classList: {
      contains(value) { return bodyClasses.has(value); },
    },
    appendChild(node) {
      node.parentNode = body;
      node.isConnected = true;
      canvases.push(node);
    },
    removeChild(node) {
      node.parentNode = null;
      node.isConnected = false;
    },
  };

  const document = {
    body,
    documentElement: {
      clientWidth: width,
      clientHeight: height,
      contains(node) { return Boolean(node?.isConnected); },
    },
    createElement(tagName) {
      assert.equal(tagName, "canvas");
      const context = createContext();
      return {
        width: 0,
        height: 0,
        style: {},
        dataset: {},
        parentNode: null,
        isConnected: false,
        context,
        setAttribute() {},
        getContext() { return context; },
      };
    },
  };

  const window = {
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio,
    document,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    matchMedia(query) {
      return {
        matches: query.includes("prefers-reduced-motion")
          ? reducedMotion
          : (query.includes("pointer: coarse") && coarsePointer),
      };
    },
  };
  window.window = window;

  vm.runInNewContext(source, { window, document }, { filename: "sonic-terrain.js" });

  return {
    api: window.MineradioSonicTerrain,
    bodyClasses,
    canvases,
    get canvas() { return canvases.at(-1); },
    get context() { return canvases.at(-1)?.context; },
  };
}

function fx(quality = "high") {
  return {
    preset: 7,
    performanceQuality: quality,
    sonicTerrainIntensity: 1,
    sonicTerrainResponse: 1,
    sonicTerrainTheme: "mono",
  };
}

function renderedPoints(frame) {
  const harness = createHarness({ devicePixelRatio: 1 });
  assert.equal(harness.api.update(1 / 60, { fx: fx(), ...frame }), true);
  return harness.context.points;
}

test("explicit normalized bands clamp above one while byte bins normalize from 255", () => {
  const saturated = renderedPoints({ bass: 1, mid: 1, treble: 1 });
  const overshooting = renderedPoints({ bass: 2, mid: 4, treble: 8 });
  const byteBins = renderedPoints({ frequencyData: Array(96).fill(255) });

  assert.deepEqual(
    overshooting,
    saturated,
    "explicit analyzer bands above one must saturate instead of being divided by 100",
  );
  assert.deepEqual(
    byteBins,
    saturated,
    "8-bit frequency bins at 255 must map to the same full-scale signal",
  );
});

test("reduced-motion preference prevents canvas creation and preset activation", () => {
  const harness = createHarness({ reducedMotion: true });

  assert.equal(harness.api.update(1 / 60, { fx: fx(), bass: 1 }), false);
  assert.equal(harness.api.onPresetChange(0, fx()), false);
  assert.equal(harness.canvases.length, 0);
});

test("quality profiles scale DPR and terrain density, with ultra unchanged on mobile", () => {
  function renderProfile(quality, mobile = false) {
    const harness = createHarness({ mobile });
    assert.equal(harness.api.update(1 / 60, { fx: fx(quality), bass: 0.6, mid: 0.4, treble: 0.2 }), true);
    return {
      width: harness.canvas.width,
      strokes: harness.context.strokeCount,
    };
  }

  const eco = renderProfile("eco");
  const balanced = renderProfile("balanced");
  const high = renderProfile("high");
  const ultra = renderProfile("ultra");
  const mobileHigh = renderProfile("high", true);
  const mobileUltra = renderProfile("ultra", true);

  assert.equal(eco.width, 1200);
  assert.equal(balanced.width, 1500);
  assert.equal(high.width, 2100);
  assert.equal(ultra.width, 2400);
  assert.equal(mobileHigh.width, 1620);
  assert.equal(mobileUltra.width, ultra.width);

  assert.ok(eco.strokes < balanced.strokes);
  assert.ok(balanced.strokes < high.strokes);
  assert.ok(high.strokes < ultra.strokes);
  assert.ok(mobileHigh.strokes < high.strokes);
  assert.equal(mobileUltra.strokes, ultra.strokes);
});

test("quality profiles throttle draw cadence while ultra renders every supplied frame", () => {
  function renderCount(quality, mobile = false) {
    const harness = createHarness({ mobile });
    for (let index = 0; index < 12; index += 1) {
      assert.equal(
        harness.api.update(1 / 60, { fx: fx(quality), bass: 0.5, mid: 0.3, treble: 0.2 }),
        true,
      );
    }
    return harness.context.clearCount;
  }

  const ecoFrames = renderCount("eco");
  const highFrames = renderCount("high");
  const mobileHighFrames = renderCount("high", true);
  const ultraFrames = renderCount("ultra");
  const mobileUltraFrames = renderCount("ultra", true);

  assert.ok(ecoFrames < highFrames);
  assert.ok(mobileHighFrames < highFrames);
  assert.equal(highFrames, 12);
  assert.equal(ultraFrames, 12);
  assert.equal(mobileUltraFrames, ultraFrames);
});
