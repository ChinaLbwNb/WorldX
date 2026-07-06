const LS_AUTH_TOKEN = "worldx_auth_token";

export function withAssetAuth(url: string): string {
  if (!url || !url.startsWith("/assets/")) return url;
  if (/[?&]token=/.test(url)) return url;
  let token = "";
  try {
    token = localStorage.getItem(LS_AUTH_TOKEN) ?? "";
  } catch {
    token = "";
  }
  if (!token) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}
