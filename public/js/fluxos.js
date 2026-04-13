// CSRF helper (double-submit cookie)
const apiFetch = window.apiFetch || ((url, options = {}) => {
  const method = String(options.method || "GET").toUpperCase();
  const needsCsrf = !["GET", "HEAD", "OPTIONS"].includes(method);
  const getCsrfToken = () =>
    document.cookie
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("csrf_token="))
      ?.split("=")[1] || "";
  const headers = { ...(options.headers || {}) };
  if (!(options.body instanceof FormData) && !('Content-Type' in headers)) {
    headers['Content-Type'] = 'application/json';
  }
  if (needsCsrf) headers['x-csrf-token'] = getCsrfToken();
  return fetch(url, { ...options, credentials: 'include', headers });
});
window.apiFetch = apiFetch;

