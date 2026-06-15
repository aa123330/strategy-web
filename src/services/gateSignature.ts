const BASE_URL = "https://api-testnet.gateapi.io/api/v4";

export async function signRequest(
  method: string,
  path: string,
  query: Record<string, string> = {},
  body: unknown = null,
  secret: string
): Promise<{ timestamp: string; signature: string }> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyText = body ? JSON.stringify(body) : "";
  const bodyBuffer = new TextEncoder().encode(bodyText);
  const hashBuffer = await crypto.subtle.digest("SHA-512", bodyBuffer);
  const bodyHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const queryString = new URLSearchParams(query).toString();
  // Gate v4 签名路径必须包含 /api/v4
  const signPath = "/api/v4" + path;
  const signString = [method.toUpperCase(), signPath, queryString, bodyHex, timestamp].join("\n");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signString));
  const sigHex = Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { timestamp, signature: sigHex };
}

export { BASE_URL };
