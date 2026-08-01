import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const [threeSource, source] = await Promise.all([
  readFile(path.join(root, "public", "classic", "vendor", "three.r128.min.js"), "utf8"),
  readFile(path.join(root, "public", "classic", "sonic-terrain.js"), "utf8"),
]);

function createHarness() {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Date,
    Math,
    performance,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(threeSource, sandbox, { filename: "three.r128.min.js" });
  vm.runInContext(source, sandbox, { filename: "sonic-terrain.js" });
  const scene = new sandbox.THREE.Scene();
  return {
    THREE: sandbox.THREE,
    api: sandbox.MineradioSonicTerrain,
    compatibilityApi: sandbox.MineradioSonicTopography,
    scene,
    sandbox,
  };
}

function terrainFx(overrides = {}) {
  return {
    preset: 7,
    performanceQuality: "high",
    sonicTerrainIntensity: 1.15,
    sonicTerrainResponse: 1.1,
    sonicTerrainTheme: "cover",
    ...overrides,
  };
}

function render(harness, fx = terrainFx(), extra = {}) {
  return harness.api.update(1 / 60, {
    scene: harness.scene,
    fx,
    time: 1,
    audio: {
      bass: 0.72,
      mid: 0.48,
      treble: 0.34,
      beat: 0.68,
      energy: 0.58,
    },
    palette: {
      primary: "#e56a8b",
      secondary: "#4f8dff",
      highlight: "#ffd0a3",
    },
    ...extra,
  });
}

function terrainRoot(harness) {
  return harness.scene.getObjectByName("sonic-topography-root");
}

test("terrain exports the Classic API without taking ownership of audio or network I/O", () => {
  const harness = createHarness();
  assert.equal(harness.api, harness.compatibilityApi);
  assert.equal(harness.api.INDEX, 7);
  assert.equal(harness.api.isActive(terrainFx()), true);
  assert.equal(harness.api.isActive({ preset: 5 }), false);
  assert.doesNotMatch(source, /AudioContext|\.src\s*=|fetch\(/);
  assert.match(source, /Copyright \(C\) 2026 XxHuberrr/);
});

test("terrain creates colored 3D instanced boxes instead of a flat canvas grid", () => {
  const harness = createHarness();
  assert.equal(render(harness), true);

  const root = terrainRoot(harness);
  assert.ok(root);
  assert.equal(root.visible, true);
  assert.ok(root.children[0].isInstancedMesh);
  assert.match(String(root.children[0].geometry.type), /BoxGeometry/);
  assert.equal(root.children[0].count, 156 * 156);
  assert.equal(root.children[1].count, 80);
  assert.ok(root.children[0].material.uniforms.uCoolCore);
  assert.ok(root.children[0].material.uniforms.uWarmCore);
  assert.ok(root.children[0].material.uniforms.uRippleColor);
  assert.match(source, /idlePeaks=pow\(smoothstep\(0\.52,0\.92,baseNoise\),2\.0\)/);
  assert.match(source, /idleElevation=\(0\.48\+idleShape\*2\.10\+idlePeaks\)\*globalFalloff/);
  assert.match(source, /max\(0\.22,topIntensity\)/);
});

test("silent buffering keeps visible idle relief and the current cover palette", () => {
  const harness = createHarness();
  const silentAudio = { bass: 0, mid: 0, treble: 0, beat: 0, energy: 0 };
  const palette = { primary: "#e56a8b", secondary: "#4f8dff", highlight: "#ffd0a3" };
  for (let frame = 0; frame < 30; frame += 1) {
    render(harness, terrainFx(), { audio: silentAudio, palette, time: frame / 60 });
  }

  const root = terrainRoot(harness);
  const uniforms = root.children[0].material.uniforms;
  assert.equal(uniforms.uSubBass.value, 0);
  assert.equal(uniforms.uMid.value, 0);
  assert.ok(root.scale.y > root.scale.x * 1.9);
  assert.ok(uniforms.uCoolCore.value.r > 0.35, "cover red should replace the blue fallback while silent");
  assert.ok(uniforms.uWarmCore.value.b > uniforms.uWarmCore.value.r, "cover secondary blue should drive the warm zone while silent");
});

test("quality caps preserve full high and ultra voxel density", () => {
  function instanceCount(quality) {
    const harness = createHarness();
    render(harness, terrainFx({ performanceQuality: quality, sonicGroundDensity: 100 }));
    return terrainRoot(harness).children[0].count;
  }

  assert.equal(instanceCount("eco"), 112 * 112);
  assert.equal(instanceCount("balanced"), 160 * 160);
  assert.equal(instanceCount("high"), 192 * 192);
  assert.equal(instanceCount("ultra"), 224 * 224);
});

test("cover and named DIY themes drive different shader colors", () => {
  function coolColor(theme, palette) {
    const harness = createHarness();
    for (let frame = 0; frame < 18; frame += 1) {
      render(harness, terrainFx({ sonicTerrainTheme: theme }), { palette });
    }
    return terrainRoot(harness).children[0].material.uniforms.uCoolCore.value.getHexString();
  }

  const coverPink = coolColor("cover", {
    primary: "#ff477e",
    secondary: "#ffb86c",
    highlight: "#ffe2ee",
  });
  const coverBlue = coolColor("cover", {
    primary: "#2f80ff",
    secondary: "#43e8ff",
    highlight: "#dff8ff",
  });
  const aurora = coolColor("aurora");
  const ocean = coolColor("ocean");

  assert.notEqual(coverPink, coverBlue);
  assert.notEqual(aurora, ocean);
  assert.notEqual(coverPink, aurora);
});

test("audio energy raises voxel uniforms and simple DIY intensity remains effective", () => {
  const harness = createHarness();
  render(harness, terrainFx({ sonicTerrainIntensity: 1.6, sonicTerrainResponse: 1.4 }));
  const uniforms = terrainRoot(harness).children[0].material.uniforms;

  assert.ok(uniforms.uBass.value > 0);
  assert.ok(uniforms.uMid.value > 0);
  assert.ok(uniforms.uEnergy.value > 0);
  assert.ok(uniforms.uAmplitude.value > 1);
});

test("preset switches hide and reuse the GPU layer instead of rebuilding it", () => {
  const harness = createHarness();
  render(harness);
  const root = terrainRoot(harness);
  const terrain = root.children[0];
  const matrixBuffer = terrain.instanceMatrix.array;

  assert.equal(harness.api.onPresetChange(7, 5, { scene: harness.scene, fx: { preset: 5 } }), false);
  assert.equal(root.visible, false);
  assert.equal(terrainRoot(harness), root);

  assert.equal(harness.api.onPresetChange(5, 7, { scene: harness.scene, fx: terrainFx() }), true);
  assert.equal(render(harness), true);
  assert.equal(terrainRoot(harness), root);
  assert.equal(terrainRoot(harness).children[0], terrain);
  assert.equal(terrain.instanceMatrix.array, matrixBuffer);

  harness.api.clear();
  assert.equal(terrainRoot(harness), undefined);
});

test("terrain initialization writes matrices in bulk and remains bounded", () => {
  const harness = createHarness();
  const startedAt = performance.now();
  render(harness, terrainFx({ performanceQuality: "ultra", sonicGroundDensity: 100 }));
  const elapsed = performance.now() - startedAt;

  assert.equal(terrainRoot(harness).children[0].count, 224 * 224);
  assert.match(source, /var matrices = mesh\.instanceMatrix\.array/);
  assert.ok(elapsed < 1500, `ultra terrain initialization took ${elapsed.toFixed(1)}ms`);
});
