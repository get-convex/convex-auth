export function requireEnv(name: string) {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`Missing environment variable \`${name}\``);
  }
  return value;
}

export function isLocalHost(host?: string) {
  const hostname = getHostname(host);
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  ) {
    return true;
  }
  if (process.env.NODE_ENV === "production") {
    return false;
  }
  return isPrivateIpv4Address(hostname) || hostname.endsWith(".local");
}

function getHostname(host?: string) {
  if (host === undefined) {
    return "";
  }
  try {
    return new URL(host.includes("://") ? host : `http://${host}`).hostname;
  } catch {
    return "";
  }
}

function isPrivateIpv4Address(hostname: string) {
  const octetStrings = hostname.split(".");
  if (
    octetStrings.length !== 4 ||
    octetStrings.some((octet) => !/^\d{1,3}$/.test(octet))
  ) {
    return false;
  }
  const octets = octetStrings.map(Number);
  if (
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}
