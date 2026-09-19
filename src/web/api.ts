export class AuthError extends Error {}
export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    signal: options?.signal ?? AbortSignal.timeout(15000),
  });
  if (response.status === 401) throw new AuthError("请重新登录");
  if (!response.ok) throw new Error("连接中断，显示上次成功同步的数据");
  return response.json();
}
export const time = (iso: string) =>
  new Date(iso).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
export const age = (iso: string, now: string) =>
  Math.max(0, Math.floor((Date.parse(now) - Date.parse(iso)) / 1000));
