export default {
  poweredByHeader: false,
  async rewrites() {
    return [{ source: "/auth/callback", destination: "/" }];
  },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Robots-Tag", value: "noindex, nofollow" }
      ]
    }];
  }
};
