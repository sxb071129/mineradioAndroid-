/*
 * MR//ROOM Classic — readable artwork loader.
 *
 * Remote artwork is converted to an object URL before it reaches a canvas.
 * This avoids browser-specific CORS image-cache reuse from tainting the Emily
 * cover texture while keeping provider URLs and account data out of storage.
 */
(function installMineradioCoverPipeline(global) {
  "use strict";

  var MAX_COVER_BYTES = 12 * 1024 * 1024;
  var DEFAULT_TIMEOUT_MS = 6500;
  var ALLOWED_IMAGE_TYPES = /^image\/(?:avif|gif|jpeg|png|webp)(?:;|$)/i;

  function uniqueSources(values) {
    var seen = Object.create(null);
    return (Array.isArray(values) ? values : [values]).map(function (value) {
      return String(value || "").trim();
    }).filter(function (value) {
      if (!value || seen[value]) return false;
      seen[value] = true;
      return true;
    });
  }

  function inlineImageSource(value) {
    return /^(?:blob:|data:image\/(?:avif|gif|jpeg|png|webp);base64,)/i.test(value);
  }

  function imageFromSource(src, crossOrigin) {
    return new Promise(function (resolve, reject) {
      var image = new Image();
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      if (crossOrigin) image.crossOrigin = "anonymous";
      image.onload = function () {
        if (!(image.naturalWidth || image.width) || !(image.naturalHeight || image.height)) {
          reject(new Error("cover_has_no_pixels"));
          return;
        }
        resolve(image);
      };
      image.onerror = function () { reject(new Error("cover_decode_failed")); };
      image.src = src;
    });
  }

  async function fetchReadableImage(src, timeoutMs) {
    if (inlineImageSource(src)) {
      return {
        image: await imageFromSource(src, false),
        source: src,
        release: function () {},
      };
    }

    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs) : 0;
    try {
      var response = await fetch(src, {
        cache: "default",
        credentials: "omit",
        mode: "cors",
        redirect: "follow",
        signal: controller ? controller.signal : undefined,
      });
      if (!response.ok || response.type === "opaque") throw new Error("cover_fetch_failed");
      var contentType = String(response.headers.get("content-type") || "").trim();
      if (!ALLOWED_IMAGE_TYPES.test(contentType)) throw new Error("cover_type_rejected");
      var announcedSize = Number(response.headers.get("content-length"));
      if (Number.isFinite(announcedSize) && announcedSize > MAX_COVER_BYTES) {
        throw new Error("cover_size_rejected");
      }
      var blob = await response.blob();
      if (!blob.size || blob.size > MAX_COVER_BYTES) throw new Error("cover_size_rejected");
      var objectUrl = URL.createObjectURL(blob);
      try {
        var image = await imageFromSource(objectUrl, false);
        return {
          image: image,
          source: src,
          release: function () { URL.revokeObjectURL(objectUrl); },
        };
      } catch (error) {
        URL.revokeObjectURL(objectUrl);
        throw error;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function loadReadableImage(sources, options) {
    var list = uniqueSources(sources);
    var timeoutMs = Math.max(1000, Math.min(15000, Number(options && options.timeoutMs) || DEFAULT_TIMEOUT_MS));
    var lastError = null;
    for (var i = 0; i < list.length; i += 1) {
      try {
        return await fetchReadableImage(list[i], timeoutMs);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("cover_source_unavailable");
  }

  global.MineradioCoverPipeline = Object.freeze({
    loadReadableImage: loadReadableImage,
  });
})(window);
