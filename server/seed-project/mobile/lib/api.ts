import * as SecureStore from "expo-secure-store"

const BASE = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8080"

async function request(method: string, path: string, body?: unknown) {
  const token = await SecureStore.getItemAsync("access_token")
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${res.status} ${path}`)
  return res.json()
}

export const api = {
  get: (p: string) => request("GET", p),
  post: (p: string, b?: unknown) => request("POST", p, b),
}
