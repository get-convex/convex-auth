import { exportJWK, exportPKCS8, generateKeyPair } from "jose";

export async function generateKeys() {
  try {
    const keys = await generateKeyPair("RS256");
    const privateKey = await exportPKCS8(keys.privateKey);
    const publicKey = await exportJWK(keys.publicKey);
    const jwks = JSON.stringify({ keys: [{ use: "sig", ...publicKey }] });
    return {
      JWT_PRIVATE_KEY: `${privateKey.trimEnd().replace(/\n/g, " ")}`,
      JWKS: jwks,
    };
  } catch (error) {
    console.error(
      "Could not generate private and public key, are you running this command using Node.js?\n",
      error,
    );
    process.exit(1);
  }
}
