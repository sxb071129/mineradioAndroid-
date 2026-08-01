export const DEFAULT_ACCOUNT_AVATAR = "/mineradio-card-art.png";

const TRUSTED_HTTP_PROVIDER_IMAGE_SUFFIXES = Object.freeze([
  ".music.126.net",
  ".music.163.com",
  ".kugou.com",
  ".kgimg.com",
  ".qpic.cn",
  ".gtimg.cn",
  ".qq.com",
]);

function trustedProviderImageHostname(hostname) {
  const value = String(hostname || "").toLowerCase();
  return TRUSTED_HTTP_PROVIDER_IMAGE_SUFFIXES.some(
    (suffix) => value === suffix.slice(1) || value.endsWith(suffix),
  );
}

export function normalizeProviderImageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 2_048) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password) return "";
    if (parsed.protocol === "http:") {
      if (!trustedProviderImageHostname(parsed.hostname) || (parsed.port && parsed.port !== "80")) {
        return "";
      }
      parsed.protocol = "https:";
      parsed.port = "";
    }
    return parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

export function accountAvatarSrc(value, fallback = DEFAULT_ACCOUNT_AVATAR) {
  return normalizeProviderImageUrl(value) || fallback;
}
