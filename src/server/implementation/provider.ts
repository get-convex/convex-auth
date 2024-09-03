import { AuthProviderMaterializedConfig } from "../index.js";

export async function hash(provider: any, secret: string) {
  if (provider.type !== "credentials") {
    throw new Error(`Provider ${provider.id} is not a credentials provider`);
  }
  const hashSecretFn = provider.crypto?.hashSecret;
  if (hashSecretFn === undefined) {
    throw new Error(
      `Provider ${provider.id} does not have a \`crypto.hashSecret\` function`,
    );
  }
  return await hashSecretFn(secret);
}

export async function verify(
  provider: AuthProviderMaterializedConfig,
  secret: string,
  hash: string,
) {
  if (provider.type !== "credentials") {
    throw new Error(`Provider ${provider.id} is not a credentials provider`);
  }
  const verifySecretFn = provider.crypto?.verifySecret;
  if (verifySecretFn === undefined) {
    throw new Error(
      `Provider ${provider.id} does not have a \`crypto.verifySecret\` function`,
    );
  }
  return await verifySecretFn(secret, hash);
}

export type GetProviderOrThrowFunc = (
  provider: string,
  allowExtraProviders?: boolean,
) => AuthProviderMaterializedConfig;

export type Config = any;
