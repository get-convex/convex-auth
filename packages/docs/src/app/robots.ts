import type { MetadataRoute } from "next";

// TODO(nicolas) Allow crawlers to index docs
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      disallow: "/",
    },
  };
}
