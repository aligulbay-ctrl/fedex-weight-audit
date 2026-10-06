import { handleUpload } from "@vercel/blob/client";
import { apiHandler } from "../../../../lib/db.js";

export const runtime = "nodejs";

// Issues short-lived client tokens for uploading the ORIGINAL invoice PDF
// straight from the browser to Vercel Blob storage - the file never passes
// through this (or any) serverless function's request body, so Vercel's
// ~4.5MB body-size limit (the whole reason PDF parsing itself moved to the
// browser - see lib/pdfParser.js) never comes into play here either, no
// matter how large the source PDF is.
//
// Requires a Blob store to be created and linked to this Vercel project
// (Vercel dashboard -> Storage -> Create Database -> Blob), which sets the
// BLOB_READ_WRITE_TOKEN env var this route reads implicitly via the SDK.
// Until that's done, calls here fail and app/upload/page.js just skips
// storing a downloadable copy of the PDF - the core upload/parse/compare
// flow never depends on this succeeding.
export const POST = apiHandler(async (req) => {
  const body = await req.json();

  const jsonResponse = await handleUpload({
    body,
    request: req,
    onBeforeGenerateToken: async (pathname) => {
      return {
        allowedContentTypes: ["application/pdf"],
        addRandomSuffix: true,
        // A little above the ~5-7MB real FedEx invoices run - generous
        // headroom without leaving the cap effectively unbounded.
        maximumSizeInBytes: 25 * 1024 * 1024,
      };
    },
  });

  return Response.json(jsonResponse);
});
