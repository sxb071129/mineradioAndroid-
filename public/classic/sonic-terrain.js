/*
 * Mineradio Sonic Terrain
 *
 * Clean-room functional adaptation inspired by the audio-reactive terrain
 * concept in upstream Mineradio v2.0.3. This file contains no upstream
 * artwork, bundle code, or runtime, and does not access the audio graph.
 */
(function installMineradioSonicTerrain() {
  "use strict";

  if (typeof window === "undefined") return;

  var previous = window.MineradioSonicTerrain;
  if (previous && typeof previous.clear === "function") {
    try { previous.clear(); } catch { }
  }

  var INDEX = 7;
  var canvas = null;
  var context = null;
  var resizeAttached = false;
  var width = 0;
  var height = 0;
  var pixelRatio = 1;
  var clock = 0;
  var energy = 0.12;
  var beatPulse = 0;
  var activeFx = null;

  function finite(value, fallback) {
    var number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function clampUnit(value) {
    value = finite(value, 0);
    if (value > 1 && value <= 100) value /= 100;
    else if (value > 1) value /= 255;
    return clamp(value, 0, 1);
  }

  function isObject(value) {
    return !!value && typeof value === "object";
  }

  function safelyRead(object, key) {
    try { return object && object[key]; } catch { return undefined; }
  }

  function frameRoots(frame) {
    var roots = [frame];
    if (!isObject(frame)) return roots;
    ["audio", "signal", "analysis", "visual", "audioFrame", "metrics"].forEach(function (key) {
      var value = safelyRead(frame, key);
      if (isObject(value)) roots.push(value);
    });
    return roots;
  }

  function findFrameValue(frame, names) {
    var roots = frameRoots(frame);
    for (var rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
      var root = roots[rootIndex];
      for (var nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
        var value = safelyRead(root, names[nameIndex]);
        if (value !== undefined && value !== null) return value;
      }
    }
    return undefined;
  }

  function averageBins(value, from, to) {
    if (!value || typeof value.length !== "number" || value.length < 1) return 0;
    var start = clamp(Math.floor(value.length * from), 0, value.length - 1);
    var end = clamp(Math.ceil(value.length * to), start + 1, value.length);
    var total = 0;
    var count = 0;
    for (var index = start; index < end; index += 1) {
      var sample = Number(value[index]);
      if (!Number.isFinite(sample)) continue;
      total += sample;
      count += 1;
    }
    return count ? clampUnit(total / count) : 0;
  }

  function readSignal(frame) {
    var bins = findFrameValue(frame, ["frequencyData", "spectrum", "frequencies", "freq", "bins"]);
    var lowFromBins = averageBins(bins, 0, 0.14);
    var middleFromBins = averageBins(bins, 0.14, 0.42);
    var highFromBins = averageBins(bins, 0.42, 0.82);
    var low = findFrameValue(frame, ["subBass", "bass", "low", "lowEnergy"]);
    var middle = findFrameValue(frame, ["mid", "middle", "midEnergy"]);
    var high = findFrameValue(frame, ["high", "treble", "highEnergy"]);
    var overall = findFrameValue(frame, ["energy", "level", "volume", "loudness"]);
    var beat = findFrameValue(frame, ["beat", "pulse", "kick", "onset"]);

    low = low === undefined ? lowFromBins : clampUnit(low);
    middle = middle === undefined ? middleFromBins : clampUnit(middle);
    high = high === undefined ? highFromBins : clampUnit(high);
    overall = overall === undefined ? (low * 0.48 + middle * 0.34 + high * 0.18) : clampUnit(overall);
    beat = beat === true ? 1 : clampUnit(beat);

    return {
      low: clamp(low, 0, 1),
      middle: clamp(middle, 0, 1),
      high: clamp(high, 0, 1),
      overall: clamp(overall, 0, 1),
      beat: clamp(beat, 0, 1)
    };
  }

  function isActive(fx) {
    if (!isObject(fx)) return false;
    if (fx.sonicTerrain === false || fx.sonicTerrainEnabled === false) return false;
    return Number(fx.preset) === INDEX || fx.sonicTerrain === true || fx.sonicTerrainEnabled === true;
  }

  function readFx(frame) {
    var candidate = isObject(frame) && (frame.fx || frame.visualSettings || frame.settings);
    if (isObject(candidate)) return candidate;
    try {
      if (isObject(window.fx) && isActive(window.fx)) return window.fx;
    } catch { }
    if (isObject(activeFx)) return activeFx;
    return null;
  }

  function readTheme(fx) {
    var theme = String((fx && fx.sonicTerrainTheme) || "cover").toLowerCase();
    return ["cover", "aurora", "ocean", "mono"].indexOf(theme) >= 0 ? theme : "cover";
  }

  function readIntensity(fx) {
    return clamp(finite(fx && fx.sonicTerrainIntensity, 0.78), 0, 2.5);
  }

  function readResponse(fx) {
    return clamp(finite(fx && fx.sonicTerrainResponse, 1), 0.15, 3);
  }

  function readRgb(value, fallback) {
    if (Array.isArray(value) && value.length >= 3) {
      return [clamp(finite(value[0], fallback[0]), 0, 255), clamp(finite(value[1], fallback[1]), 0, 255), clamp(finite(value[2], fallback[2]), 0, 255)];
    }
    if (typeof value !== "string") return fallback.slice();
    var text = value.trim();
    var hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
    if (hex) {
      var raw = hex[1].length === 3 ? hex[1].replace(/(.)/g, "$1$1") : hex[1];
      return [parseInt(raw.slice(0, 2), 16), parseInt(raw.slice(2, 4), 16), parseInt(raw.slice(4, 6), 16)];
    }
    var rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(text);
    if (rgb) return [clamp(finite(rgb[1], 0), 0, 255), clamp(finite(rgb[2], 0), 0, 255), clamp(finite(rgb[3], 0), 0, 255)];
    return fallback.slice();
  }

  function findCoverColor(frame) {
    var palette = findFrameValue(frame, ["palette", "colors", "coverPalette"]);
    if (isObject(palette)) {
      var paletteColor = palette.primary || palette.accent || palette.vibrant || palette[0];
      if (paletteColor) return readRgb(paletteColor, [104, 223, 255]);
    }
    return readRgb(findFrameValue(frame, ["coverColor", "accentColor", "color"]), [104, 223, 255]);
  }

  function paletteFor(theme, frame) {
    var accent = findCoverColor(frame);
    if (theme === "aurora") return { base: [8, 18, 27], glow: [87, 255, 180], edge: [178, 104, 255], accent: [90, 231, 208] };
    if (theme === "ocean") return { base: [3, 17, 34], glow: [45, 170, 255], edge: [67, 238, 235], accent: [107, 113, 255] };
    if (theme === "mono") return { base: [9, 10, 13], glow: [238, 241, 247], edge: [145, 152, 164], accent: [255, 255, 255] };
    return {
      base: [5, 10, 19],
      glow: accent,
      edge: [clamp(accent[0] + 62, 0, 255), clamp(accent[1] + 25, 0, 255), clamp(accent[2] + 24, 0, 255)],
      accent: [clamp(accent[0] + 20, 0, 255), clamp(accent[1] + 54, 0, 255), clamp(accent[2] + 72, 0, 255)]
    };
  }

  function rgba(color, alpha) {
    return "rgba(" + Math.round(color[0]) + "," + Math.round(color[1]) + "," + Math.round(color[2]) + "," + clamp(alpha, 0, 1).toFixed(3) + ")";
  }

  function resize() {
    if (!canvas || !context || typeof window === "undefined") return;
    var nextWidth = Math.max(1, Math.round(window.innerWidth || document.documentElement.clientWidth || 1));
    var nextHeight = Math.max(1, Math.round(window.innerHeight || document.documentElement.clientHeight || 1));
    var nextRatio = clamp(finite(window.devicePixelRatio, 1), 1, 2);
    if (nextWidth === width && nextHeight === height && nextRatio === pixelRatio) return;

    width = nextWidth;
    height = nextHeight;
    pixelRatio = nextRatio;
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    canvas.width = Math.max(1, Math.round(width * pixelRatio));
    canvas.height = Math.max(1, Math.round(height * pixelRatio));
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  }

  function ensureCanvas() {
    if (typeof document === "undefined" || !document.body) return false;
    var connected = !!(canvas && (canvas.isConnected !== undefined
      ? canvas.isConnected
      : (document.documentElement && document.documentElement.contains && document.documentElement.contains(canvas))));
    if (!canvas || !connected) {
      canvas = document.createElement("canvas");
      canvas.className = "mineradio-sonic-terrain";
      canvas.setAttribute("aria-hidden", "true");
      canvas.dataset.mineradioSonicTerrain = "true";
      canvas.style.cssText = [
        "position:fixed",
        "inset:0",
        "width:100vw",
        "height:100vh",
        "pointer-events:none",
        "z-index:1",
        "opacity:0",
        "mix-blend-mode:screen",
        "transition:opacity 240ms ease"
      ].join(";");
      context = canvas.getContext("2d", { alpha: true, desynchronized: true });
      if (!context) {
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
        canvas = null;
        return false;
      }
      document.body.appendChild(canvas);
    }
    if (!resizeAttached && typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("resize", resize, { passive: true });
      resizeAttached = true;
    }
    resize();
    return true;
  }

  function waveY(x, depth, signal, intensity, response, phase) {
    var normalized = x / Math.max(1, width);
    var horizonWeight = Math.pow(depth, 1.8);
    var primary = Math.sin(normalized * 8.7 + phase * (1.05 + depth * 0.6));
    var detail = Math.sin(normalized * 25.3 - phase * 1.63 + depth * 6.4) * 0.32;
    var shimmer = Math.sin(normalized * 49.0 + phase * 2.1) * signal.high * 0.16;
    var amplitude = (3 + 30 * horizonWeight) * intensity * (0.28 + signal.low * response * 0.82 + beatPulse * 0.35);
    return (primary + detail + shimmer) * amplitude;
  }

  function drawTerrain(frame, fx, signal) {
    if (!context || !canvas || !width || !height) return;

    var intensity = readIntensity(fx);
    var response = readResponse(fx);
    var palette = paletteFor(readTheme(fx), frame);
    var horizon = height * (0.43 + Math.min(0.06, signal.middle * 0.06));
    var bottom = height * 1.06;
    var phase = clock * (0.65 + signal.overall * response * 1.45);
    var rows = Math.round(15 + intensity * 13);
    var columns = Math.round(13 + intensity * 10);
    var segments = Math.max(38, Math.round(width / 18));

    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);

    var haze = context.createRadialGradient(width * 0.5, horizon, 0, width * 0.5, horizon, Math.max(width, height) * 0.68);
    haze.addColorStop(0, rgba(palette.glow, 0.12 * intensity + beatPulse * 0.06));
    haze.addColorStop(0.47, rgba(palette.base, 0.05));
    haze.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = haze;
    context.fillRect(0, 0, width, height);

    var horizonGlow = context.createLinearGradient(0, horizon - 26, 0, horizon + 38);
    horizonGlow.addColorStop(0, "rgba(0,0,0,0)");
    horizonGlow.addColorStop(0.48, rgba(palette.edge, 0.18 + beatPulse * 0.1));
    horizonGlow.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = horizonGlow;
    context.fillRect(0, horizon - 28, width, 70);

    context.lineCap = "round";
    context.lineJoin = "round";
    for (var row = 0; row < rows; row += 1) {
      var depth = row / Math.max(1, rows - 1);
      var perspective = Math.pow(depth, 1.72);
      var y = horizon + (bottom - horizon) * perspective;
      var rowAlpha = (0.055 + perspective * 0.31) * (0.68 + intensity * 0.45);
      context.beginPath();
      for (var segment = 0; segment <= segments; segment += 1) {
        var x = width * segment / segments;
        var terrainY = y + waveY(x, depth, signal, intensity, response, phase + depth * 2.2);
        if (segment === 0) context.moveTo(x, terrainY);
        else context.lineTo(x, terrainY);
      }
      context.lineWidth = 0.45 + perspective * 0.92;
      context.strokeStyle = rgba(depth > 0.56 ? palette.accent : palette.glow, rowAlpha);
      context.stroke();
    }

    for (var column = 0; column <= columns; column += 1) {
      var ratio = column / Math.max(1, columns);
      context.beginPath();
      for (var verticalRow = 0; verticalRow <= rows; verticalRow += 1) {
        var verticalDepth = verticalRow / Math.max(1, rows);
        var verticalPerspective = Math.pow(verticalDepth, 1.74);
        var spread = 0.08 + verticalPerspective * 1.13;
        var drift = Math.sin(phase * 0.72 + verticalDepth * 4.1) * (4 + 15 * verticalPerspective) * signal.middle;
        var xPosition = width * 0.5 + (ratio - 0.5) * width * spread + drift;
        var yPosition = horizon + (bottom - horizon) * verticalPerspective + waveY(xPosition, verticalDepth, signal, intensity, response, phase + 1.8);
        if (verticalRow === 0) context.moveTo(xPosition, yPosition);
        else context.lineTo(xPosition, yPosition);
      }
      context.lineWidth = 0.35 + intensity * 0.18;
      context.strokeStyle = rgba(palette.edge, 0.07 + intensity * 0.08 + beatPulse * 0.05);
      context.stroke();
    }

    var crest = context.createLinearGradient(0, bottom - height * 0.26, 0, bottom);
    crest.addColorStop(0, "rgba(0,0,0,0)");
    crest.addColorStop(1, rgba(palette.base, 0.20 + (1 - signal.high) * 0.12));
    context.fillStyle = crest;
    context.fillRect(0, bottom - height * 0.3, width, height * 0.3);

    canvas.style.opacity = String(clamp(0.28 + intensity * 0.24 + energy * 0.22, 0, 0.82));
  }

  function update(dt, frame) {
    var fx = readFx(frame);
    if (!isActive(fx)) {
      if (canvas) clear();
      return false;
    }
    activeFx = fx;
    if (!ensureCanvas()) return false;

    var seconds = finite(dt, 1 / 60);
    if (seconds > 1) seconds /= 1000;
    seconds = clamp(seconds, 1 / 240, 0.2);
    var signal = readSignal(frame);
    var response = readResponse(fx);
    var targetEnergy = clamp(signal.overall * 0.62 + signal.low * 0.28 + signal.middle * 0.1, 0, 1) * response;
    energy += (targetEnergy - energy) * Math.min(1, seconds * 7.2);
    beatPulse = Math.max(signal.beat, beatPulse * Math.exp(-seconds * 5.6));
    clock += seconds * (0.75 + energy * 1.45);
    drawTerrain(frame, fx, signal);
    return true;
  }

  function onPresetChange(previousPreset, nextPreset) {
    var nextFx = isObject(nextPreset) ? nextPreset : null;
    var nextIsActive = nextFx ? isActive(nextFx) : Number(nextPreset) === INDEX;
    if (!nextIsActive) {
      clear();
      return false;
    }
    if (nextFx) activeFx = nextFx;
    else if (isObject(window.fx)) activeFx = Object.assign({}, window.fx, { preset: INDEX });
    else activeFx = { preset: INDEX };
    clock = 0;
    energy = 0.12;
    beatPulse = 0;
    return ensureCanvas();
  }

  function clear() {
    if (resizeAttached && typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("resize", resize);
      resizeAttached = false;
    }
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    canvas = null;
    context = null;
    width = 0;
    height = 0;
    pixelRatio = 1;
    activeFx = null;
  }

  window.MineradioSonicTerrain = {
    INDEX: INDEX,
    isActive: isActive,
    update: update,
    onPresetChange: onPresetChange,
    clear: clear
  };
})();
