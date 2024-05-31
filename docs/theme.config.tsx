import React from "react";
import { DocsThemeConfig, useConfig } from "nextra-theme-docs";
import { Details, Summary } from "./components/details";

const config: DocsThemeConfig = {
  logo: (
    <span style={{ fontWeight: "bold", fontSize: "1.5rem" }}>Convex Auth</span>
  ),
  project: {
    link: "https://github.com/get-convex/convex-auth",
  },
  chat: {
    link: "https://www.convex.dev/community",
  },
  useNextSeoProps() {
    return {
      titleTemplate: "%s - Convex Auth",
    };
  },
  head: () => {
    const { frontMatter } = useConfig();
    return (
      <>
        <meta
          property="og:title"
          content={frontMatter.title || "Convex Auth"}
        />
        <meta
          property="og:description"
          content={
            "Relations, default values, unique fields and more for Convex"
          }
        />
      </>
    );
  },
  docsRepositoryBase:
    "https://github.com/get-convex/convex-auth/tree/main/docs",
  gitTimestamp() {
    return <></>;
  },
  footer: {
    text: "Copyright © 2024 Convex, Inc.",
  },
  components: {
    details: Details,
    summary: Summary,
  },
};

export default config;
