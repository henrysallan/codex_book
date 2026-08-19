"use client";

import { useState } from "react";
import dynamic from "next/dynamic";

const PdfTest = dynamic(() => import("./PdfTestInner"), { ssr: false });

export default function PdfTestPage() {
  return <PdfTest />;
}
