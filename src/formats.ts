import { inflateSync } from "node:zlib";

/**
 * Reading the formats medical records actually arrive in.
 *
 * Twelve of the twenty-one retrievable sources are PDF; four are FHIR. Building
 * only for FHIR handles the minority, which is how a record ends up "complete"
 * while missing every visit note and every radiology report.
 *
 * No dependencies. Each parser here is narrow on purpose — enough to read what
 * a hospital actually sends, and honest about what it cannot read rather than
 * returning something plausible. A scanned page that yields no text must say so,
 * because an empty string and "this is an image of a page" mean very different
 * things when you are deciding whether you hold your own medical history.
 */

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

export type PdfText = {
  text: string;
  pages: number;
  /** Set when nothing readable came out, explaining why. */
  problem: string | null;
};

/**
 * Text out of a PDF, without a PDF library.
 *
 * A PDF's visible text lives in content streams as operators: `(literal) Tj`,
 * or arrays for kerned runs, `[(H)-20(ello)] TJ`. Streams are usually
 * Flate-compressed, which Bun's zlib handles.
 *
 * What this deliberately does not attempt: encrypted PDFs, non-Latin encodings
 * via CMap tables, and scanned pages, which contain no text at all. Each is
 * detected and reported rather than silently yielding nothing — a hospital
 * record that appears blank is worse than one that says "this is a scan".
 */
export function pdfText(bytes: Uint8Array): PdfText {
  const raw = Buffer.from(bytes);
  const latin = raw.toString("latin1");

  const pages = (latin.match(/\/Type\s*\/Page[^s]/g) ?? []).length || 1;

  if (/\/Encrypt\b/.test(latin)) {
    return { text: "", pages, problem: "encrypted — needs the password" };
  }

  const chunks: string[] = [];

  // Every stream in the file, decompressed where possible.
  const streamRe = /stream\r?\n?([\s\S]*?)\r?\n?endstream/g;
  let m: RegExpExecArray | null;
  let flateFailures = 0;

  while ((m = streamRe.exec(latin)) !== null) {
    const start = m.index + m[0].indexOf(m[1]);
    const body = raw.subarray(start, start + m[1].length);

    let content: string;
    try {
      content = inflateSync(body).toString("latin1");
    } catch {
      // Not Flate, or not a content stream. Uncompressed streams are readable
      // as-is, which older and simpler PDFs still use.
      const asText = body.toString("latin1");
      if (/\bTj\b|\bTJ\b/.test(asText)) content = asText;
      else {
        flateFailures++;
        continue;
      }
    }

    chunks.push(extractOperators(content));
  }

  const text = chunks.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  if (text.length === 0) {
    return {
      text: "",
      pages,
      problem:
        flateFailures > 0
          ? "no text layer — most likely a scan, which needs OCR"
          : "no text operators found",
    };
  }

  return { text, pages, problem: null };
}

/**
 * Pull the string arguments out of text-showing operators.
 *
 * `Tj` shows one string. `TJ` shows an array with kerning numbers between the
 * pieces, which have to be dropped or the output reads "H-20ello". `'` and `"`
 * are Tj with an implicit line break.
 */
function extractOperators(content: string): string {
  const out: string[] = [];

  /**
   * One ordered pass, not arrays-then-singles.
   *
   * Matching `TJ` arrays first and `Tj` strings afterwards produces every line
   * of the document in the wrong order — a lab report where the values precede
   * the patient name. The operators have to be read in the order they appear,
   * which means one alternation rather than two passes.
   */
  const op = /\[((?:[^\[\]\\]|\\.)*)\]\s*TJ|\(((?:[^()\\]|\\.)*)\)\s*(?:Tj|'|")/g;

  let m: RegExpExecArray | null;
  while ((m = op.exec(content)) !== null) {
    if (m[1] !== undefined) {
      // A kerned run: concatenate the literals, drop the spacing numbers.
      const parts: string[] = [];
      const lit = /\(((?:[^()\\]|\\.)*)\)/g;
      let p: RegExpExecArray | null;
      while ((p = lit.exec(m[1])) !== null) parts.push(unescapePdf(p[1]));
      out.push(parts.join(""));
    } else if (m[2] !== undefined) {
      out.push(unescapePdf(m[2]));
    }
  }

  return out.join("\n");
}

function unescapePdf(s: string): string {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\([()\\])/g, "$1")
    // Octal escapes, which is how PDFs carry anything above ASCII.
    .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
}

// ---------------------------------------------------------------------------
// C-CDA
// ---------------------------------------------------------------------------

export type CdaSection = { title: string; text: string; code: string | null };
export type Cda = {
  title: string | null;
  patient: string | null;
  effective: string | null;
  custodian: string | null;
  sections: CdaSection[];
};

/**
 * A Continuity of Care Document.
 *
 * Every certified EHR must produce one, which makes it the most reliably
 * available whole-record summary — often obtainable from a portal by a provider
 * whose FHIR API you cannot get credentials for.
 *
 * The narrative blocks are parsed rather than the coded entries. That is a
 * deliberate trade: the coded half is a thicket of template ids that varies by
 * vendor, while the narrative is what a clinician actually reads and is required
 * to be equivalent to the codes. Getting the readable half of every section
 * beats getting the coded half of some of them.
 */
export function parseCda(xml: string): Cda {
  const tag = (name: string, src = xml): string | null => {
    const m = src.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
    return m ? m[1] : null;
  };
  const attr = (name: string, a: string, src = xml): string | null => {
    const m = src.match(new RegExp(`<${name}\\b[^>]*\\b${a}="([^"]*)"`, "i"));
    return m ? m[1] : null;
  };

  const patientBlock = tag("patientRole") ?? "";
  const given = tag("given", patientBlock);
  const family = tag("family", patientBlock);

  const sections: CdaSection[] = [];
  const sectionRe = /<section\b[^>]*>([\s\S]*?)<\/section>/gi;
  let m: RegExpExecArray | null;

  while ((m = sectionRe.exec(xml)) !== null) {
    const body = m[1];
    const title = strip(tag("title", body) ?? "") || "Untitled section";
    const narrative = tag("text", body);
    if (!narrative) continue;
    sections.push({
      title,
      text: strip(narrative),
      code: attr("code", "code", body),
    });
  }

  return {
    title: strip(tag("title") ?? "") || null,
    patient: [given, family].filter(Boolean).map(strip).join(" ") || null,
    effective: attr("effectiveTime", "value"),
    custodian: strip(tag("name", tag("custodian") ?? "") ?? "") || null,
    sections,
  };
}

/**
 * XML narrative to readable text.
 *
 * Tables matter here and are the reason this is not one regex. A CDA lab
 * section is a table, and stripping tags without preserving cell boundaries
 * turns "Sodium 141 mmol/L" into "Sodium141mmol/L" — which is unreadable and
 * unsearchable.
 */
function strip(xml: string): string {
  return xml
    .replace(/<br\s*\/?>/gi, "\n")
    // `item` belongs here: a CDA medication list uses <item>, and without it
    // every drug runs into the next — "Lisinopril 10 mg dailyAtorvastatin".
    .replace(/<\/(tr|p|li|item|div|title|caption)>/gi, "\n")
    .replace(/<\/(td|th)>/gi, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    // Collapse runs of space but keep tabs, which are the cell boundaries.
    .replace(/ {2,}/g, " ")
    // A row ends "…mmol/L\t\n"; the trailing tab would otherwise survive as a
    // blank-looking cell and push an empty line between every table row.
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\t/g, " ")
    // All runs of newlines become one. The source XML is indented, so every
    // table row arrives followed by a newline from </tr> and another from the
    // whitespace between elements — a blank line between every lab value.
    // CDA narrative carries no meaning in blank lines, so collapsing is safe.
    .replace(/\n{2,}/g, "\n")
    .trim();
}

// ---------------------------------------------------------------------------
// DICOM
// ---------------------------------------------------------------------------

export type DicomMeta = {
  patient: string | null;
  studyDate: string | null;
  modality: string | null;
  description: string | null;
  bodyPart: string | null;
  institution: string | null;
  studyUid: string | null;
};

/** Tags worth reading. The pixel data is deliberately not touched. */
const DICOM_TAGS: Record<string, keyof DicomMeta> = {
  "00100010": "patient",
  "00080020": "studyDate",
  "00080060": "modality",
  "00081030": "description",
  "00180015": "bodyPart",
  "00080080": "institution",
  "0020000D": "studyUid",
};

/**
 * Metadata out of a DICOM file.
 *
 * A CD from radiology is the usual way an individual gets imaging, and it
 * contains hundreds of files with no index a person can read. This pulls enough
 * to say what a study is and when it happened, so it can sit on the timeline —
 * without decoding a single pixel, which needs a real library and answers a
 * question nobody is asking of a timeline.
 *
 * Only explicit-VR little-endian is handled, which is what CDs are written in.
 * Implicit VR is detected and reported rather than misparsed into plausible
 * nonsense.
 */
export function dicomMeta(bytes: Uint8Array): DicomMeta | { problem: string } {
  // 128-byte preamble, then the magic.
  if (bytes.length < 132) return { problem: "too short to be DICOM" };
  const magic = String.fromCharCode(...bytes.subarray(128, 132));
  if (magic !== "DICM") return { problem: "not a DICOM file — no DICM marker" };

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: DicomMeta = {
    patient: null,
    studyDate: null,
    modality: null,
    description: null,
    bodyPart: null,
    institution: null,
    studyUid: null,
  };

  let i = 132;
  const dec = new TextDecoder("latin1");

  while (i + 8 <= bytes.length) {
    const group = view.getUint16(i, true);
    const element = view.getUint16(i + 2, true);
    const vr = String.fromCharCode(bytes[i + 4], bytes[i + 5]);

    let length: number;
    let valueAt: number;

    if (/^[A-Z]{2}$/.test(vr)) {
      // Explicit VR. These four use a 32-bit length after two reserved bytes.
      if (["OB", "OW", "OF", "SQ", "UT", "UN"].includes(vr)) {
        length = view.getUint32(i + 8, true);
        valueAt = i + 12;
      } else {
        length = view.getUint16(i + 6, true);
        valueAt = i + 8;
      }
    } else {
      // Implicit VR: the length sits where the VR would be. Rather than guess
      // at a dictionary, stop — a wrong guess produces confident nonsense.
      return { problem: "implicit VR DICOM — needs a tag dictionary to read" };
    }

    // Undefined length means a sequence; skipping its contents needs proper
    // delimiter handling, so stop rather than walk off into pixel data.
    if (length === 0xffffffff) break;
    if (valueAt + length > bytes.length) break;

    const tag = (group.toString(16).padStart(4, "0") + element.toString(16).padStart(4, "0")).toUpperCase();
    const field = DICOM_TAGS[tag];
    if (field) {
      out[field] = dec.decode(bytes.subarray(valueAt, valueAt + length)).replace(/\0+$/, "").trim() || null;
    }

    i = valueAt + length + (length % 2); // elements are even-length padded
    // Past the study-level tags; nothing further is wanted and the rest is bulk.
    if (group > 0x0020 && out.studyUid) break;
  }

  return out;
}

/** DICOM dates are YYYYMMDD with no separators. */
export function dicomDate(value: string | null): string | null {
  if (!value || !/^\d{8}$/.test(value)) return null;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export type Format = "pdf" | "ccda" | "dicom" | "xml" | "json" | "csv" | "rtf" | "html" | "text";

/**
 * What a file is, from its contents rather than its extension.
 *
 * Records arrive with names like `document.pdf` that are actually TIFFs, and
 * `export.xml` that could be C-CDA or a HealthKit export. Sniffing the bytes is
 * the only reliable answer and costs nothing.
 */
export function detectFormat(bytes: Uint8Array, filename = ""): Format {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));

  if (head.startsWith("%PDF")) return "pdf";
  if (bytes.length > 132 && String.fromCharCode(...bytes.subarray(128, 132)) === "DICM") return "dicom";
  if (head.startsWith("{\\rtf")) return "rtf";

  if (/^\s*[{[]/.test(head)) return "json";
  if (/<ClinicalDocument/i.test(head)) return "ccda";
  if (/^\s*<\?xml|^\s*</.test(head)) return /<html/i.test(head) ? "html" : "xml";
  if (/<html/i.test(head)) return "html";

  // A CSV needs consistent delimiters across the first lines, not just one comma.
  const lines = head.split(/\r?\n/).filter(Boolean).slice(0, 4);
  if (lines.length >= 2) {
    const counts = lines.map((l) => (l.match(/,/g) ?? []).length);
    if (counts[0] > 0 && counts.every((c) => c === counts[0])) return "csv";
  }

  if (filename.toLowerCase().endsWith(".csv")) return "csv";
  return "text";
}
