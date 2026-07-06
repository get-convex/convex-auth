import {
  decryptAssertion as decryptAssertionXmlEnc,
  encryptAssertion as encryptAssertionXmlEnc,
} from "./xmlenc";
import { readPrivateKey, base64Encode } from "./encoding";
import { getPublicKeyPemFromCert } from "./crypto";
import { SamlNamespace } from "./constants";
import { getContext } from "./api";
import { selectXPath as select, isElementNode, serializeXmlNode } from "./dom/select";
import type { SamlEntitySettings } from "./types";
import type { SamlMetadata } from "./metadata";

/** Minimal entity shape consumed when (de/en)crypting an assertion. */
interface AssertionCryptoEntity {
  entitySetting: SamlEntitySettings;
  entityMeta: SamlMetadata;
}

/** Encrypt the assertion section in a response, resolving the finalized base64 XML. */
export function encryptAssertion(
  sourceEntity: AssertionCryptoEntity,
  targetEntity: AssertionCryptoEntity,
  xml?: string,
) {
  return new Promise<string>((resolve, reject) => {
    if (!xml) {
      return reject(new Error("ERR_UNDEFINED_ASSERTION"));
    }

    const sourceSamlEntitySettings = sourceEntity.entitySetting;
    const targetEntityMetadata = targetEntity.entityMeta;
    const { dom } = getContext();
    const doc = dom!.parseFromString(xml);
    const assertions = select("//*[local-name(.)='Assertion']", doc).filter(isElementNode);
    if (assertions.length === 0) {
      throw new Error("ERR_NO_ASSERTION");
    }
    if (assertions.length > 1) {
      throw new Error("ERR_MULTIPLE_ASSERTION");
    }
    const rawAssertionNode = assertions[0];

    if (sourceSamlEntitySettings.isAssertionEncrypted) {
      /**
       * `getX509Certificate` is typed `string | string[] | null` for rolling-cert
       * callers; the encryption certificate consumed here is a single PEM string,
       * as the encrypt API and prior `any` typing both require.
       */
      const encryptCert = targetEntityMetadata.getX509Certificate("encryption") as string;
      const publicKeyPem = getPublicKeyPemFromCert(encryptCert);

      encryptAssertionXmlEnc({
        assertionXml: serializeXmlNode(rawAssertionNode),
        publicKeyPem,
        certificate: encryptCert,
        encryptionAlgorithm: sourceSamlEntitySettings.dataEncryptionAlgorithm!,
        keyEncryptionAlgorithm: sourceSamlEntitySettings.keyEncryptionAlgorithm!,
      })
        .then((res) => {
          const { encryptedAssertion: encAssertionPrefix } = sourceSamlEntitySettings.tagPrefix!;
          const encryptAssertionDoc = dom!.parseFromString(
            `<${encAssertionPrefix}:EncryptedAssertion xmlns:${encAssertionPrefix}="${SamlNamespace.assertion}">${res}</${encAssertionPrefix}:EncryptedAssertion>`,
          );
          doc.documentElement.replaceChild(encryptAssertionDoc.documentElement, rawAssertionNode);
          return resolve(base64Encode(serializeXmlNode(doc)));
        })
        .catch((err) => {
          console.error(err);
          return reject(new Error("ERR_EXCEPTION_OF_ASSERTION_ENCRYPTION"));
        });
    } else {
      return resolve(base64Encode(xml));
    }
  });
}

/** Decrypt the encrypted assertion in a response, resolving the entire XML and the assertion. */
export function decryptAssertion(here: { entitySetting: SamlEntitySettings }, entireXML: string) {
  return new Promise<[string, string]>((resolve, reject) => {
    if (!entireXML) {
      return reject(new Error("ERR_UNDEFINED_ASSERTION"));
    }
    const hereSetting = here.entitySetting;
    const { dom } = getContext();
    const doc = dom!.parseFromString(entireXML);
    const encryptedAssertions = select(
      "/*[contains(local-name(), 'Response')]/*[local-name(.)='EncryptedAssertion']",
      doc,
    ).filter(isElementNode);
    if (encryptedAssertions.length === 0) {
      throw new Error("ERR_UNDEFINED_ENCRYPTED_ASSERTION");
    }
    if (encryptedAssertions.length > 1) {
      throw new Error("ERR_MULTIPLE_ASSERTION");
    }
    const encAssertionNode = encryptedAssertions[0];

    return decryptAssertionXmlEnc({
      encryptedAssertionXml: serializeXmlNode(encAssertionNode),
      privateKey: readPrivateKey(hereSetting.encPrivateKey!, hereSetting.encPrivateKeyPass),
    })
      .then((res) => {
        const rawAssertionDoc = dom!.parseFromString(res);
        doc.documentElement.replaceChild(rawAssertionDoc.documentElement, encAssertionNode);
        return resolve([serializeXmlNode(doc), res]);
      })
      .catch((err) => {
        console.error(err);
        return reject(new Error("ERR_EXCEPTION_OF_ASSERTION_DECRYPTION"));
      });
  });
}
