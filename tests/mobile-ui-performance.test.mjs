import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("Classic touch surfaces enter a bounded scroll-performance mode", async () => {
  const html = await readFile(new URL("public/classic/index.html", root), "utf8");

  assert.match(html, /function markMobileUiScroll\(\)/);
  assert.match(html, /classList\.add\('mobile-ui-scrolling'\)/);
  assert.match(html, /setTimeout\(finishMobileUiScroll,\s*180\)/);
  assert.match(html, /classList\.contains\('mobile-ui-scrolling'\)\) return 30/);
  assert.match(html, /#empty-home[\s\S]*?addEventListener\('scroll', markMobileUiScroll, \{ passive:true \}\)/);
});

test("Classic mobile and tablet layouts avoid nested snap and stretched tiles", async () => {
  const html = await readFile(new URL("public/classic/index.html", root), "utf8");

  assert.match(html, /body\.mobile-optimized\.controls-visible #empty-home[^}]*bottom:calc\(env\(safe-area-inset-bottom,0px\) \+ 86px\)/);
  assert.match(html, /body\.mobile-optimized \.home-tile-row[^}]*scroll-snap-type:none/);
  assert.match(html, /orientation:portrait\) and \(min-width:721px\) and \(max-width:900px\)/);
  assert.match(html, /\.home-tile-row\{[\s\S]*?grid-auto-rows:minmax\(128px,auto\);[\s\S]*?align-items:start/);
  assert.match(html, /orientation:landscape\) and \(max-height:620px\)/);
});
