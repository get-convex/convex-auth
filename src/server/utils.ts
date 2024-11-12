export function requireEnv(name: string) {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`Missing environment variable \`${name}\``);
  }
  return value;
}

export function isLocalHost(host?: string) {
  return /(localhost|127\.0\.0\.1):\d+/.test(
  host ?? "");
}