export function isSafeSessionName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!value || value !== value.trim() || value.length > 220) return false;
  if (value === "." || value === "..") return false;
  return !/[\\/:*?"<>|\u0000-\u001f\u007f]/.test(value);
}
