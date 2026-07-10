import {
  AlignmentType,
  Document,
  Footer,
  HeadingLevel,
  ImageRun,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableOfContents,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

// Génération DOCX du rapport de projet (#130). Contenu STRICTEMENT issu de la base
// (sections, entrées, preuves, captures) — aucune prose inventée ici.

export type DocxSectionInput = {
  section_number: string;
  title: string;
  description: string | null;
  depth: 0 | 1;
  status: string;
  markdown: string | null; // validated_markdown sinon ai_draft_markdown sinon null
  is_validated: boolean;
  evidence: { type: string; title: string; url: string | null }[];
  assets: { title: string; description: string | null; mime_type: string | null; content_base64: string | null }[];
};

export type DocxReportInput = {
  title: string;
  project_name: string;
  project_code: string;
  author_name: string;
  academic_year: string | null;
  version: string;
  confidential: boolean;
  sections: DocxSectionInput[];
  versions_history: { version: string; title: string; created_at: string }[];
};

const FONT = "Calibri";

function runsFromInline(text: string, base?: { bold?: boolean }): TextRun[] {
  // Inline minimal : **gras**, `code`. Déterministe, sans HTML.
  const runs: TextRun[] = [];
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter((p) => p !== "");
  for (const part of parts) {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      runs.push(new TextRun({ text: part.slice(2, -2), bold: true, font: FONT }));
    } else if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      runs.push(new TextRun({ text: part.slice(1, -1), font: "Consolas", size: 20 }));
    } else {
      runs.push(new TextRun({ text: part, bold: base?.bold, font: FONT }));
    }
  }
  return runs.length ? runs : [new TextRun({ text, font: FONT })];
}

// Markdown simple → paragraphes docx (titres, puces, numéroté, texte).
export function markdownToParagraphs(markdown: string): Paragraph[] {
  const out: Paragraph[] = [];
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const levels = [HeadingLevel.HEADING_3, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_4] as const;
      out.push(new Paragraph({ heading: levels[h[1].length - 1], children: runsFromInline(h[2]) }));
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(new Paragraph({ children: runsFromInline(bullet[1]), bullet: { level: 0 }, spacing: { after: 60 } }));
      continue;
    }
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      out.push(new Paragraph({ children: runsFromInline(numbered[1]), bullet: { level: 0 }, spacing: { after: 60 } }));
      continue;
    }
    out.push(new Paragraph({ children: runsFromInline(line), spacing: { after: 120 }, alignment: AlignmentType.JUSTIFIED }));
  }
  return out;
}

function evidenceTable(evidence: DocxSectionInput["evidence"]): Table {
  const header = new TableRow({
    children: ["Type", "Preuve", "Référence"].map(
      (t) =>
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: t, bold: true, font: FONT })] })],
        })
    ),
  });
  const rows = evidence.map(
    (e) =>
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: e.type, font: FONT })] })] }),
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: e.title, font: FONT })] })] }),
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: e.url ?? "—", font: FONT, size: 18 })] })] }),
        ],
      })
  );
  return new Table({ rows: [header, ...rows], width: { size: 100, type: WidthType.PERCENTAGE } });
}

function sectionBlocks(s: DocxSectionInput): (Paragraph | Table)[] {
  const blocks: (Paragraph | Table)[] = [];
  blocks.push(
    new Paragraph({
      heading: s.depth === 0 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
      children: [new TextRun({ text: `${s.section_number}. ${s.title}`, font: FONT })],
      spacing: { before: s.depth === 0 ? 360 : 240, after: 120 },
    })
  );
  if (s.depth === 0 && s.description) {
    blocks.push(
      new Paragraph({
        children: [new TextRun({ text: s.description, italics: true, color: "555555", font: FONT })],
        spacing: { after: 160 },
      })
    );
  }
  if (s.markdown && s.markdown.trim()) {
    if (!s.is_validated) {
      blocks.push(
        new Paragraph({
          children: [new TextRun({ text: "Brouillon IA à valider", bold: true, color: "B45309", font: FONT })],
          spacing: { after: 80 },
        })
      );
    }
    blocks.push(...markdownToParagraphs(s.markdown));
  } else {
    blocks.push(
      new Paragraph({
        children: [new TextRun({ text: "À compléter.", italics: true, color: "999999", font: FONT })],
        spacing: { after: 120 },
      })
    );
  }
  for (const a of s.assets) {
    if (a.content_base64 && a.mime_type && /^image\/(png|jpe?g)$/i.test(a.mime_type)) {
      try {
        const data = Buffer.from(a.content_base64, "base64");
        blocks.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new ImageRun({
                data,
                transformation: { width: 480, height: 300 },
                type: /png$/i.test(a.mime_type) ? "png" : "jpg",
              }),
            ],
            spacing: { before: 120, after: 40 },
          })
        );
      } catch {
        // image illisible : on garde la légende seule
      }
    }
    blocks.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: `Figure — ${a.title}${a.description ? ` : ${a.description}` : ""}`, italics: true, size: 18, font: FONT })],
        spacing: { after: 160 },
      })
    );
  }
  if (s.evidence.length) {
    blocks.push(
      new Paragraph({
        children: [new TextRun({ text: "Preuves associées", bold: true, font: FONT })],
        spacing: { before: 120, after: 60 },
      })
    );
    blocks.push(evidenceTable(s.evidence));
  }
  return blocks;
}

export async function buildReportDocx(input: DocxReportInput): Promise<Buffer> {
  const cover: Paragraph[] = [
    new Paragraph({ spacing: { before: 2400 }, children: [] }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: input.title, bold: true, size: 56, font: FONT })],
      spacing: { after: 240 },
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: `Projet ${input.project_name} (${input.project_code})`, size: 28, font: FONT })],
      spacing: { after: 120 },
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: `Auteur : ${input.author_name}`, size: 24, font: FONT })],
      spacing: { after: 60 },
    }),
    ...(input.academic_year
      ? [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: `Année académique : ${input.academic_year}`, size: 24, font: FONT })],
          spacing: { after: 60 },
        })]
      : []),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: `Version ${input.version}`, size: 22, color: "555555", font: FONT })],
      spacing: { after: 240 },
    }),
    ...(input.confidential
      ? [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: "CONFIDENTIEL — diffusion restreinte", bold: true, color: "B91C1C", size: 24, font: FONT })],
        })]
      : []),
    new Paragraph({ children: [new PageBreak()] }),
  ];

  const toc: (Paragraph | TableOfContents)[] = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: "Table des matières", font: FONT })] }),
    new TableOfContents("Table des matières", { hyperlink: true, headingStyleRange: "1-2" }),
    new Paragraph({
      children: [new TextRun({ text: "(Dans Word : clic droit → « Mettre à jour les champs » pour rafraîchir la table.)", italics: true, size: 18, color: "777777", font: FONT })],
    }),
    new Paragraph({ children: [new PageBreak()] }),
  ];

  const body = input.sections.flatMap(sectionBlocks);

  const annex: (Paragraph | Table)[] = [];
  if (input.versions_history.length) {
    annex.push(new Paragraph({ children: [new PageBreak()] }));
    annex.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: "Annexe — Historique des versions", font: FONT })] }));
    annex.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({
            children: ["Version", "Intitulé", "Date"].map(
              (t) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: t, bold: true, font: FONT })] })] })
            ),
          }),
          ...input.versions_history.map(
            (v) =>
              new TableRow({
                children: [v.version, v.title, v.created_at.slice(0, 10)].map(
                  (t) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: t, font: FONT })] })] })
                ),
              })
          ),
        ],
      })
    );
  }

  const doc = new Document({
    creator: "CERP Project Office",
    title: input.title,
    description: `Rapport de projet ${input.project_code}`,
    styles: {
      default: {
        document: { run: { font: FONT, size: 22 } },
        heading1: { run: { size: 32, bold: true, color: "1F2937", font: FONT }, paragraph: { spacing: { before: 360, after: 160 } } },
        heading2: { run: { size: 26, bold: true, color: "374151", font: FONT }, paragraph: { spacing: { before: 240, after: 120 } } },
      },
    },
    features: { updateFields: true },
    sections: [
      {
        properties: {},
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: input.confidential ? "Confidentiel — " : "", size: 16, color: "999999", font: FONT }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 16, color: "999999", font: FONT }),
                ],
              }),
            ],
          }),
        },
        children: [...cover, ...toc, ...body, ...annex],
      },
    ],
  });
  return Packer.toBuffer(doc);
}
