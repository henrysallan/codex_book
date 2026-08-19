"use client";

import { useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

export default function PdfTestInner() {
  const [numPages, setNumPages] = useState(0);
  const [url, setUrl] = useState("");

  return (
    <div style={{ padding: 20 }}>
      <h1>PDF Text Selection Test</h1>
      <p>Paste a URL to a PDF file (or use a local blob URL):</p>
      <input
        type="text"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="Enter PDF URL..."
        style={{ width: 400, padding: 8, marginBottom: 16 }}
      />
      <p style={{ fontSize: 12, color: "#666" }}>
        Or try: <button onClick={() => setUrl("https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf")} style={{ color: "blue", textDecoration: "underline", background: "none", border: "none", cursor: "pointer" }}>Load sample PDF</button>
      </p>

      {url && (
        <div style={{ marginTop: 16, maxHeight: "80vh", overflow: "auto", background: "#eee", padding: 16 }}>
          <Document
            file={url}
            onLoadSuccess={({ numPages: n }) => setNumPages(n)}
            onLoadError={(err) => console.error("PDF load error:", err)}
          >
            {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => (
              <Page
                key={pageNum}
                pageNumber={pageNum}
                renderAnnotationLayer={false}
                renderTextLayer={true}
              />
            ))}
          </Document>
        </div>
      )}

      <div style={{ marginTop: 16, padding: 12, background: "#f9f9f9", borderRadius: 8, fontSize: 13 }}>
        <strong>Diagnostics:</strong>
        <ul>
          <li>pdfjs version: {pdfjs.version}</li>
          <li>Worker src: {String(pdfjs.GlobalWorkerOptions.workerSrc)}</li>
          <li>Pages loaded: {numPages}</li>
        </ul>
        <p>Try selecting text on the rendered PDF above. If you can&apos;t, text selection is broken at the react-pdf level.</p>
      </div>
    </div>
  );
}
