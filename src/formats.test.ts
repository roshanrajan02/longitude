import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { detectFormat, dicomDate, dicomMeta, parseCda, pdfText } from "./formats";
import { guessDate } from "./documents";

/**
 * Format parsing.
 *
 * Twelve of the twenty-one retrievable sources arrive as PDF and only four as
 * FHIR, so these parsers carry more of the record than the structured importers
 * do. Each test below is a way of producing something that looks like a medical
 * record and is wrong.
 */

/** A minimal PDF with one Flate-compressed content stream. */
function makePdf(ops: string): Uint8Array {
  const comp = deflateSync(Buffer.from(ops, "latin1"));
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  parts.push(Buffer.from("1 0 obj\n<< /Type /Page >>\nendobj\n"));
  parts.push(Buffer.from(`2 0 obj\n<< /Length ${comp.length} /Filter /FlateDecode >>\nstream\n`));
  parts.push(comp);
  parts.push(Buffer.from("\nendstream\nendobj\ntrailer\n<< >>\n%%EOF"));
  return new Uint8Array(Buffer.concat(parts));
}

describe("PDF", () => {
  test("reads text out of a compressed stream", () => {
    const r = pdfText(makePdf("BT (Discharge Summary) Tj ET"));
    expect(r.text).toContain("Discharge Summary");
    expect(r.problem).toBeNull();
  });

  test("kerned runs are joined without their spacing numbers", () => {
    // A TJ array is how justified text is written. Naively keeping the numbers
    // yields "Sodium-20141 mmol/L", which reads as a value and is not one.
    const r = pdfText(makePdf("BT [(Sodium )-20(141 mmol/L)] TJ ET"));
    expect(r.text).toBe("Sodium 141 mmol/L");
  });

  test("operators come out in document order", () => {
    // Matching arrays before strings put lab values above the patient name.
    const r = pdfText(makePdf("BT (Patient: A) Tj [(Sodium )-20(141)] TJ (Creatinine 0.9) Tj ET"));
    expect(r.text.split("\n")).toEqual(["Patient: A", "Sodium 141", "Creatinine 0.9"]);
  });

  test("octal escapes become their characters", () => {
    const r = pdfText(makePdf("BT (caf\\351) Tj ET"));
    expect(r.text).toBe("café");
  });

  test("escaped parentheses do not end the string early", () => {
    const r = pdfText(makePdf("BT (Sodium \\(Na\\) 141) Tj ET"));
    expect(r.text).toBe("Sodium (Na) 141");
  });

  test("a scan reports why it is empty rather than returning nothing", () => {
    // The failure that matters. A blank hospital record and an image of one are
    // different facts, and only one of them means you should ask for OCR.
    const img = new Uint8Array(
      Buffer.concat([
        Buffer.from("%PDF-1.4\n/Type /Page\n"),
        Buffer.from("stream\n"),
        Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
        Buffer.from("\nendstream\n%%EOF"),
      ]),
    );
    const r = pdfText(img);
    expect(r.text).toBe("");
    expect(r.problem).toContain("scan");
  });

  test("an encrypted PDF says so", () => {
    const enc = new Uint8Array(Buffer.from("%PDF-1.4\n<< /Encrypt 5 0 R >>\n%%EOF"));
    expect(pdfText(enc).problem).toContain("encrypted");
  });
});

describe("C-CDA", () => {
  const doc = `<?xml version="1.0"?><ClinicalDocument xmlns="urn:hl7-org:v3">
    <title>Summary</title><effectiveTime value="20240416103000-0500"/>
    <recordTarget><patientRole><patient><name><given>Ana</given><family>Ruiz</family></name></patient></patientRole></recordTarget>
    <component><section><code code="30954-2"/><title>Results</title>
      <text><table><tbody>
        <tr><td>Sodium</td><td>141</td><td>mmol/L</td></tr>
        <tr><td>Potassium</td><td>4.1</td><td>mmol/L</td></tr>
      </tbody></table></text></section></component>
    <component><section><title>Medications</title>
      <text><list><item>Lisinopril 10 mg</item><item>Atorvastatin 20 mg</item></list></text>
    </section></component></ClinicalDocument>`;

  test("sections and their narratives are read", () => {
    const c = parseCda(doc);
    expect(c.sections.map((s) => s.title)).toEqual(["Results", "Medications"]);
    expect(c.patient).toBe("Ana Ruiz");
  });

  test("table cells stay separated", () => {
    // Stripping tags without preserving cell boundaries yields
    // "Sodium141mmol/L", which is neither readable nor searchable.
    const results = parseCda(doc).sections[0];
    expect(results.text).toContain("Sodium 141 mmol/L");
    expect(results.text).toContain("Potassium 4.1 mmol/L");
  });

  test("one row per line, with no blank lines between them", () => {
    // Source XML is indented, so every row arrives with a newline from </tr>
    // and another from the whitespace between elements.
    expect(parseCda(doc).sections[0].text.split("\n")).toEqual([
      "Sodium 141 mmol/L",
      "Potassium 4.1 mmol/L",
    ]);
  });

  test("list items do not run together", () => {
    // Without <item> breaking, this reads "Lisinopril 10 mgAtorvastatin 20 mg".
    expect(parseCda(doc).sections[1].text.split("\n")).toEqual([
      "Lisinopril 10 mg",
      "Atorvastatin 20 mg",
    ]);
  });

  test("entities are decoded", () => {
    const c = parseCda(
      `<ClinicalDocument><component><section><title>N</title><text>Sat &gt; 95% &amp; stable</text></section></component></ClinicalDocument>`,
    );
    expect(c.sections[0].text).toBe("Sat > 95% & stable");
  });
});

describe("DICOM", () => {
  function makeDicom(elements: [number, number, string, string][]): Uint8Array {
    const parts: Buffer[] = [Buffer.alloc(128), Buffer.from("DICM")];
    for (const [g, e, vr, val] of elements) {
      const v = Buffer.from(val.length % 2 ? val + " " : val, "latin1");
      const h = Buffer.alloc(8);
      h.writeUInt16LE(g, 0);
      h.writeUInt16LE(e, 2);
      h.write(vr, 4, "latin1");
      h.writeUInt16LE(v.length, 6);
      parts.push(h, v);
    }
    return new Uint8Array(Buffer.concat(parts));
  }

  const study = makeDicom([
    [0x0008, 0x0020, "DA", "20240315"],
    [0x0008, 0x0060, "CS", "MR"],
    [0x0008, 0x1030, "LO", "MRI LUMBAR SPINE"],
    [0x0010, 0x0010, "PN", "RUIZ^ANA"],
  ]);

  test("study metadata is read", () => {
    const m = dicomMeta(study);
    expect(m).toMatchObject({ modality: "MR", description: "MRI LUMBAR SPINE", patient: "RUIZ^ANA" });
  });

  test("dates become ISO", () => {
    expect(dicomDate("20240315")).toBe("2024-03-15");
    expect(dicomDate("bad")).toBeNull();
    expect(dicomDate(null)).toBeNull();
  });

  test("a file without the marker is refused", () => {
    // A CD full of JPEGs named .dcm is common. Parsing one as DICOM produces
    // field values that look real.
    const notDicom = new Uint8Array(Buffer.concat([Buffer.alloc(128), Buffer.from("JPEG")]));
    expect(dicomMeta(notDicom)).toEqual({ problem: "not a DICOM file — no DICM marker" });
  });

  test("implicit VR is reported rather than guessed at", () => {
    const implicit = new Uint8Array(
      Buffer.concat([Buffer.alloc(128), Buffer.from("DICM"), Buffer.from([0x08, 0x00, 0x20, 0x00, 0x08, 0x00, 0x00, 0x00])]),
    );
    const r = dicomMeta(implicit) as { problem: string };
    expect(r.problem).toContain("implicit VR");
  });
});

describe("format detection", () => {
  const u8 = (s: string) => new Uint8Array(Buffer.from(s));

  test("sniffs from bytes, not the extension", () => {
    // Records arrive named .pdf that are not.
    expect(detectFormat(u8("%PDF-1.4\n"), "scan.tiff")).toBe("pdf");
    expect(detectFormat(u8("Plain text"), "report.pdf")).toBe("text");
  });

  test("C-CDA is distinguished from other XML", () => {
    expect(detectFormat(u8('<?xml version="1.0"?><ClinicalDocument>'), "a.xml")).toBe("ccda");
    expect(detectFormat(u8('<?xml version="1.0"?><HealthData>'), "export.xml")).toBe("xml");
  });

  test("a single comma is not a CSV", () => {
    expect(detectFormat(u8("Dear Dr Smith,\nPlease find enclosed the results."), "x")).toBe("text");
    expect(detectFormat(u8("date,value,unit\n2024-01-01,141,mmol/L\n"), "x")).toBe("csv");
  });
});

describe("date guessing", () => {
  test("reads the common written formats", () => {
    expect(guessDate("Collected 2024-03-15 at 09:12")).toBe("2024-03-15");
    expect(guessDate("Date of service 03/15/2024")).toBe("2024-03-15");
    expect(guessDate("Seen on March 15, 2024 by Dr Ruiz")).toBe("2024-03-15");
  });

  test("prefers the earliest plausible date", () => {
    // Reports print a generated-on date at the top and the clinical date lower.
    // The clinical one is what belongs on a timeline.
    expect(guessDate("Printed 2024-06-01\nDate of service 2024-03-15")).toBe("2024-03-15");
  });

  test("ignores future dates", () => {
    // A follow-up appointment is not this document's date.
    expect(guessDate("Visit 2024-03-15. Follow up 2099-01-01.")).toBe("2024-03-15");
  });

  test("returns null rather than inventing one", () => {
    expect(guessDate("No dates here at all")).toBeNull();
  });
});
