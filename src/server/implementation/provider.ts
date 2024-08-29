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

export type GetProviderOrThrowFunc = (
  provider: string,
  allowExtraProviders?: boolean,
) => AuthProviderMaterializedConfig;
