/** @type {import('next').NextConfig} */
const nextConfig = {
  // The PDF report route (app/api/export/pdf) reads DejaVu Sans font files
  // from assets/fonts/ at request time via fs.readFileSync. Next.js's build
  // only bundles files it can trace from static imports, so a dynamic
  // fs.readFileSync call needs to be explicitly listed here - otherwise the
  // fonts are missing once deployed to Vercel (works locally because the
  // files just happen to be on disk there) and every PDF export fails.
  outputFileTracingIncludes: {
    "/api/export/pdf": ["./assets/fonts/**"],
  },
};

export default nextConfig;
