// Some code in this file is originally from Supabase.
// https://github.com/supabase/supabase/blob/719c28f31ea34b67a304274a52b3a0e2624dddfe/apps/docs/components/AppleSecretGenerator/AppleSecretGenerator.tsx
// The code was modified to use shadcn/ui components.

// Apache License
// Version 2.0, January 2004
// http://www.apache.org/licenses/

// TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

// 1. Definitions.

// "License" shall mean the terms and conditions for use, reproduction,
// and distribution as defined by Sections 1 through 9 of this document.

// "Licensor" shall mean the copyright owner or entity authorized by
// the copyright owner that is granting the License.

// "Legal Entity" shall mean the union of the acting entity and all
// other entities that control, are controlled by, or are under common
// control with that entity. For the purposes of this definition,
// "control" means (i) the power, direct or indirect, to cause the
// direction or management of such entity, whether by contract or
// otherwise, or (ii) ownership of fifty percent (50%) or more of the
// outstanding shares, or (iii) beneficial ownership of such entity.

// "You" (or "Your") shall mean an individual or Legal Entity
// exercising permissions granted by this License.

// "Source" form shall mean the preferred form for making modifications,
// including but not limited to software source code, documentation
// source, and configuration files.

// "Object" form shall mean any form resulting from mechanical
// transformation or translation of a Source form, including but
// not limited to compiled object code, generated documentation,
// and conversions to other media types.

// "Work" shall mean the work of authorship, whether in Source or
// Object form, made available under the License, as indicated by a
// copyright notice that is included in or attached to the work
// (an example is provided in the Appendix below).

// "Derivative Works" shall mean any work, whether in Source or Object
// form, that is based on (or derived from) the Work and for which the
// editorial revisions, annotations, elaborations, or other modifications
// represent, as a whole, an original work of authorship. For the purposes
// of this License, Derivative Works shall not include works that remain
// separable from, or merely link (or bind by name) to the interfaces of,
// the Work and Derivative Works thereof.

// "Contribution" shall mean any work of authorship, including
// the original version of the Work and any modifications or additions
// to that Work or Derivative Works thereof, that is intentionally
// submitted to Licensor for inclusion in the Work by the copyright owner
// or by an individual or Legal Entity authorized to submit on behalf of
// the copyright owner. For the purposes of this definition, "submitted"
// means any form of electronic, verbal, or written communication sent
// to the Licensor or its representatives, including but not limited to
// communication on electronic mailing lists, source code control systems,
// and issue tracking systems that are managed by, or on behalf of, the
// Licensor for the purpose of discussing and improving the Work, but
// excluding communication that is conspicuously marked or otherwise
// designated in writing by the copyright owner as "Not a Contribution."

// "Contributor" shall mean Licensor and any individual or Legal Entity
// on behalf of whom a Contribution has been received by Licensor and
// subsequently incorporated within the Work.

// 2. Grant of Copyright License. Subject to the terms and conditions of
// this License, each Contributor hereby grants to You a perpetual,
// worldwide, non-exclusive, no-charge, royalty-free, irrevocable
// copyright license to reproduce, prepare Derivative Works of,
// publicly display, publicly perform, sublicense, and distribute the
// Work and such Derivative Works in Source or Object form.

// 3. Grant of Patent License. Subject to the terms and conditions of
// this License, each Contributor hereby grants to You a perpetual,
// worldwide, non-exclusive, no-charge, royalty-free, irrevocable
// (except as stated in this section) patent license to make, have made,
// use, offer to sell, sell, import, and otherwise transfer the Work,
// where such license applies only to those patent claims licensable
// by such Contributor that are necessarily infringed by their
// Contribution(s) alone or by combination of their Contribution(s)
// with the Work to which such Contribution(s) was submitted. If You
// institute patent litigation against any entity (including a
// cross-claim or counterclaim in a lawsuit) alleging that the Work
// or a Contribution incorporated within the Work constitutes direct
// or contributory patent infringement, then any patent licenses
// granted to You under this License for that Work shall terminate
// as of the date such litigation is filed.

// 4. Redistribution. You may reproduce and distribute copies of the
// Work or Derivative Works thereof in any medium, with or without
// modifications, and in Source or Object form, provided that You
// meet the following conditions:

// (a) You must give any other recipients of the Work or
// Derivative Works a copy of this License; and

// (b) You must cause any modified files to carry prominent notices
// stating that You changed the files; and

// (c) You must retain, in the Source form of any Derivative Works
// that You distribute, all copyright, patent, trademark, and
// attribution notices from the Source form of the Work,
// excluding those notices that do not pertain to any part of
// the Derivative Works; and

// (d) If the Work includes a "NOTICE" text file as part of its
// distribution, then any Derivative Works that You distribute must
// include a readable copy of the attribution notices contained
// within such NOTICE file, excluding those notices that do not
// pertain to any part of the Derivative Works, in at least one
// of the following places: within a NOTICE text file distributed
// as part of the Derivative Works; within the Source form or
// documentation, if provided along with the Derivative Works; or,
// within a display generated by the Derivative Works, if and
// wherever such third-party notices normally appear. The contents
// of the NOTICE file are for informational purposes only and
// do not modify the License. You may add Your own attribution
// notices within Derivative Works that You distribute, alongside
// or as an addendum to the NOTICE text from the Work, provided
// that such additional attribution notices cannot be construed
// as modifying the License.

// You may add Your own copyright statement to Your modifications and
// may provide additional or different license terms and conditions
// for use, reproduction, or distribution of Your modifications, or
// for any such Derivative Works as a whole, provided Your use,
// reproduction, and distribution of the Work otherwise complies with
// the conditions stated in this License.

// 5. Submission of Contributions. Unless You explicitly state otherwise,
// any Contribution intentionally submitted for inclusion in the Work
// by You to the Licensor shall be under the terms and conditions of
// this License, without any additional terms or conditions.
// Notwithstanding the above, nothing herein shall supersede or modify
// the terms of any separate license agreement you may have executed
// with Licensor regarding such Contributions.

// 6. Trademarks. This License does not grant permission to use the trade
// names, trademarks, service marks, or product names of the Licensor,
// except as required for reasonable and customary use in describing the
// origin of the Work and reproducing the content of the NOTICE file.

// 7. Disclaimer of Warranty. Unless required by applicable law or
// agreed to in writing, Licensor provides the Work (and each
// Contributor provides its Contributions) on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
// implied, including, without limitation, any warranties or conditions
// of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
// PARTICULAR PURPOSE. You are solely responsible for determining the
// appropriateness of using or redistributing the Work and assume any
// risks associated with Your exercise of permissions under this License.

// 8. Limitation of Liability. In no event and under no legal theory,
// whether in tort (including negligence), contract, or otherwise,
// unless required by applicable law (such as deliberate and grossly
// negligent acts) or agreed to in writing, shall any Contributor be
// liable to You for damages, including any direct, indirect, special,
// incidental, or consequential damages of any character arising as a
// result of this License or out of the use or inability to use the
// Work (including but not limited to damages for loss of goodwill,
// work stoppage, computer failure or malfunction, or any and all
// other commercial damages or losses), even if such Contributor
// has been advised of the possibility of such damages.

// 9. Accepting Warranty or Additional Liability. While redistributing
// the Work or Derivative Works thereof, You may choose to offer,
// and charge a fee for, acceptance of support, warranty, indemnity,
// or other liability obligations and/or rights consistent with this
// License. However, in accepting such obligations, You may act only
// on Your own behalf and on Your sole responsibility, not on behalf
// of any other Contributor, and only if You agree to indemnify,
// defend, and hold each Contributor harmless for any liability
// incurred by, or claims asserted against, such Contributor by reason
// of your accepting any such warranty or additional liability.

// END OF TERMS AND CONDITIONS

// APPENDIX: How to apply the Apache License to your work.

// To apply the Apache License to your work, attach the following
// boilerplate notice, with the fields enclosed by brackets "[]"
// replaced with your own identifying information. (Don't include
// the brackets!)  The text should be enclosed in the appropriate
// comment syntax for the file format. We also recommend that a
// file or class name and description of purpose be included on the
// same "printed page" as the copyright notice for easier
// identification within third-party archives.

// Copyright 2024 Supabase
// Copyright 2024 Convex, Inc.

// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at

// http://www.apache.org/licenses/LICENSE-2.0

// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Callout } from "nextra/components";

function base64URL(value: string) {
  return globalThis
    .btoa(value)
    .replace(/[=]/g, "")
    .replace(/[+]/g, "-")
    .replace(/[\/]/g, "_");
}

/*
Convert a string into an ArrayBuffer
from https://developers.google.com/web/updates/2012/06/How-to-convert-ArrayBuffer-to-and-from-String
*/
function stringToArrayBuffer(value: string) {
  const buf = new ArrayBuffer(value.length);
  const bufView = new Uint8Array(buf);
  for (let i = 0; i < value.length; i++) {
    bufView[i] = value.charCodeAt(i);
  }
  return buf;
}

function arrayBufferToString(buf) {
  return String.fromCharCode.apply(null, new Uint8Array(buf));
}

const generateAppleSecretKey = async (
  kid: string,
  iss: string,
  sub: string,
  file: File,
): Promise<{ kid: string; jwt: string; exp: number }> => {
  if (!kid) {
    const match = file.name.match(/AuthKey_([^.]+)[.].*$/i);
    if (match && match[1]) {
      kid = match[1];
    }
  }

  if (!kid) {
    throw new Error(
      `No Key ID provided. The file "${file.name}" does not follow the AuthKey_XXXXXXXXXX.p8 pattern. Please provide a Key ID manually.`,
    );
  }

  const contents = await file.text();

  if (
    !contents.match(/^\s*-+BEGIN PRIVATE KEY-+[^-]+-+END PRIVATE KEY-+\s*$/i)
  ) {
    throw new Error(
      `Chosen file does not appear to be a PEM encoded PKCS8 private key file.`,
    );
  }

  // remove PEM headers and spaces
  const pkcs8 = stringToArrayBuffer(
    globalThis.atob(contents.replace(/-+[^-]+-+/g, "").replace(/\s+/g, "")),
  );

  const privateKey = await globalThis.crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    true,
    ["sign"],
  );

  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 180 * 24 * 60 * 60;

  const jwt = [
    base64URL(JSON.stringify({ typ: "JWT", kid, alg: "ES256" })),
    base64URL(
      JSON.stringify({
        iss,
        sub,
        iat,
        exp,
        aud: "https://appleid.apple.com",
      }),
    ),
  ];

  const signature = await globalThis.crypto.subtle.sign(
    {
      name: "ECDSA",
      hash: "SHA-256",
    },
    privateKey,
    stringToArrayBuffer(jwt.join(".")),
  );

  jwt.push(base64URL(arrayBufferToString(signature)));

  return { kid, jwt: jwt.join("."), exp };
};

export const AppleSecretGenerator = () => {
  const [file, setFile] = useState({ file: null as File | null });
  const [teamID, setTeamID] = useState("");
  const [serviceID, setServiceID] = useState("");
  const [keyID, setKeyID] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState("");

  return (
    <>
      <Label className="inline-block mt-4" aria-required htmlFor="team-input">
        Account ID
      </Label>
      <Input
        className="mt-2"
        id="team-input"
        placeholder="Apple Developer account ID, 10 alphanumeric digits"
        value={teamID}
        onChange={(e) => setTeamID(e.target.value.trim())}
      />
      <p className="mt-2 text-sm text-gray-400">
        Found in the upper-right corner of Apple Developer Center.
      </p>

      <Label
        className="inline-block mt-4"
        aria-required
        htmlFor="service-id-input"
      >
        Service ID
      </Label>
      <Input
        id="service-id-input"
        placeholder="ID of the service, example: com.example.app.service"
        value={serviceID}
        onChange={(e) => setServiceID(e.target.value.trim())}
      />
      <p className="mt-2 text-sm text-gray-400">
        Found under Certificates, Identifiers & Profiles in Apple Developer
        Center.
      </p>

      <div>
        <Label className="block mt-4" htmlFor="key-file-input">
          AuthKey_XXXXXXXXXX.p8 file
        </Label>
        <input
          className="mt-2"
          id="key-file-input"
          type="file"
          onChange={(e) => {
            setFile({ file: e.target.files[0] });
          }}
        />
        <p className="mt-2 text-sm text-gray-400">
          The key file you generated and downloaded earlier.
        </p>
      </div>

      <Label className="inline-block mt-4" htmlFor="key-id-input">
        Key ID (optional)
      </Label>
      <Input
        id="key-id-input"
        placeholder="Extracted from filename, AuthKey_XXXXXXXXXX.p8"
        value={keyID}
        onChange={(e) => setKeyID(e.target.value.trim())}
      />
      <p className="mt-2 text-sm text-gray-400">
        If the file you select does not preserve the original name from Apple
        Developer Center, please enter the key ID.
      </p>

      <Button
        className="mt-4"
        disabled={
          !(
            teamID.length === 10 &&
            serviceID &&
            ((globalThis && globalThis.showOpenFilePicker) || file.file)
          )
        }
        onClick={async () => {
          setError("");

          try {
            const { kid, jwt, exp } = await generateAppleSecretKey(
              keyID,
              teamID,
              serviceID,
              file.file,
            );
            setKeyID(kid);
            setSecretKey(jwt);
            setExpiresAt(new Date(exp * 1000).toString());
            setError("");
          } catch (e: any) {
            setError(e.message);
            console.error(e);
          }
        }}
      >
        Generate Secret Key
      </Button>

      {error && <Callout type="error">{error}</Callout>}

      {secretKey && (
        <>
          <Label className="block mt-4" htmlFor="secret-key-result">
            Secret Key
          </Label>
          <Input id="secret-key-result" value={secretKey} />
          <p className="mt-2 text-sm text-gray-400">{`Valid until: ${expiresAt}. Make sure you generate a new one before then!`}</p>
        </>
      )}
    </>
  );
};
