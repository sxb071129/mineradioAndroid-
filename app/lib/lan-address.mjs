function ipv4Score(value) {
  const parts = String(value || "").split(".");
  if (parts.length !== 4) return -1;
  const octets = parts.map((part) => /^\d{1,3}$/.test(part) ? Number(part) : -1);
  if (octets.some((part) => part < 0 || part > 255)) return -1;
  const [first, second] = octets;
  if (first === 127 || first === 0 || first >= 224 || (first === 169 && second === 254)) return -1;
  if (first === 192 && second === 168) return 400;
  if (first === 10) return 350;
  if (first === 172 && second >= 16 && second <= 31) return 300;
  if (first === 100 && second >= 64 && second <= 127) return 250;
  return 100;
}

export function preferredLanHost(addresses, currentHost = "localhost") {
  const normalizedCurrent = String(currentHost || "localhost").replace(/^\[|\]$/g, "").toLowerCase();
  if (!["localhost", "127.0.0.1", "::1"].includes(normalizedCurrent)) return String(currentHost);

  const candidates = (Array.isArray(addresses) ? addresses : [])
    .map((address, index) => ({ host: String(address || ""), score: ipv4Score(address), index }))
    .filter((candidate) => candidate.score >= 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  return candidates[0]?.host || String(currentHost || "localhost");
}
