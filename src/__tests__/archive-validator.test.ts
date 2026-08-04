import { crc32, deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  ARCHIVE_VALIDATION_LIMITS,
  archiveMatchesExtension,
  type StructuralArchiveExtension,
} from "../shared/uploads/archive-validator";

type ZipFixtureEntry = Readonly<{
  name: string;
  content?: Buffer | string;
  compression?: "store" | "deflate";
  flags?: number;
  crcOverride?: number;
}>;

const UTF8_FLAG = 0x0800;

function makeZip(entries: readonly ZipFixtureEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const fixture of entries) {
    const name = Buffer.from(fixture.name, "utf8");
    const content = typeof fixture.content === "string"
      ? Buffer.from(fixture.content, "utf8")
      : fixture.content ?? Buffer.alloc(0);
    const method = fixture.compression === "deflate" ? 8 : 0;
    const compressed = method === 8 ? deflateRawSync(content) : content;
    const checksum = fixture.crcOverride ?? crc32(content);
    const flags = UTF8_FLAG | (fixture.flags ?? 0);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt32LE(checksum >>> 0, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localParts.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(checksum >>> 0, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE((0o100600 << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);
    localOffset += localHeader.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function source(buffer: Buffer) {
  return { buffer, size: buffer.length } as const;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

const CONTENT_TYPES_XML = (partName: string, contentType: string) => `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Override PartName="/${partName}" ContentType="${contentType}"/>
</Types>`;

const RELATIONSHIPS_XML = (target: string, type: string) => `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${type}" Target="${target}"/>
</Relationships>`;

function ooxmlEntries(extension: ".docx" | ".xlsx" | ".pptx"): ZipFixtureEntry[] {
  const specification = {
    ".docx": {
      path: "word/document.xml",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
      body: '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
    },
    ".xlsx": {
      path: "xl/workbook.xml",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
      body: '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
    },
    ".pptx": {
      path: "ppt/presentation.xml",
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
      body: '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
    },
  } as const;
  const selected = specification[extension];
  return [
    { name: "[Content_Types].xml", content: CONTENT_TYPES_XML(selected.path, selected.contentType), compression: "deflate" },
    {
      name: "_rels/.rels",
      content: RELATIONSHIPS_XML(
        selected.path,
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
      ),
      compression: "deflate",
    },
    { name: selected.path, content: selected.body, compression: "deflate" },
  ];
}

function odfEntries(extension: ".odt" | ".ods"): ZipFixtureEntry[] {
  const mediaType = extension === ".odt"
    ? "application/vnd.oasis.opendocument.text"
    : "application/vnd.oasis.opendocument.spreadsheet";
  return [
    { name: "mimetype", content: mediaType, compression: "store" },
    {
      name: "META-INF/manifest.xml",
      content: `<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mediaType}"/></manifest:manifest>`,
      compression: "deflate",
    },
    { name: "content.xml", content: "<?xml version=\"1.0\"?><office:document-content xmlns:office=\"urn:oasis:names:tc:opendocument:xmlns:office:1.0\"/>", compression: "deflate" },
  ];
}

describe("validation structurelle bornée des archives uploadées", () => {
  it("refuse un préfixe PK forgé et les répertoires centraux tronqués ou invalides", async () => {
    const forged = Buffer.from("PKnot-a-zip", "ascii");
    expect(await archiveMatchesExtension(".zip", source(forged), signal())).toBe(false);

    const valid = makeZip([{ name: "proof.txt", content: "safe" }]);
    expect(await archiveMatchesExtension(".zip", source(valid.subarray(0, valid.length - 1)), signal())).toBe(false);

    const invalidCentral = Buffer.from(valid);
    const eocdOffset = invalidCentral.length - 22;
    const centralOffset = invalidCentral.readUInt32LE(eocdOffset + 16);
    invalidCentral.writeUInt32LE(0x41414141, centralOffset);
    expect(await archiveMatchesExtension(".zip", source(invalidCentral), signal())).toBe(false);
  });

  it.each([
    [".zip", [{ name: "proof.txt", content: "safe", compression: "deflate" }]],
    [".docx", ooxmlEntries(".docx")],
    [".xlsx", ooxmlEntries(".xlsx")],
    [".pptx", ooxmlEntries(".pptx")],
    [".odt", odfEntries(".odt")],
    [".ods", odfEntries(".ods")],
    [".3mf", [
      {
        name: "[Content_Types].xml",
        content: CONTENT_TYPES_XML("3D/3dmodel.model", "application/vnd.ms-package.3dmanufacturing-3dmodel+xml"),
        compression: "deflate",
      },
      {
        name: "_rels/.rels",
        content: RELATIONSHIPS_XML("/3D/3dmodel.model", "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"),
        compression: "deflate",
      },
      { name: "3D/3dmodel.model", content: '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"/>', compression: "deflate" },
    ]],
  ] as const)("accepte un conteneur %s structurellement et sémantiquement valide", async (extension, entries) => {
    const archive = makeZip(entries);
    expect(await archiveMatchesExtension(extension as StructuralArchiveExtension, source(archive), signal())).toBe(true);
  });

  it("accepte un DOCX volumineux dont les marqueurs package sont hors des échantillons head/tail", async () => {
    const entries: ZipFixtureEntry[] = [
      { name: "padding.bin", content: Buffer.alloc(220 * 1024, 0x41), compression: "store" },
      ...ooxmlEntries(".docx"),
    ];
    for (let index = 0; index < 1_200; index += 1) {
      entries.push({ name: `customXml/padding-${index.toString().padStart(4, "0")}.bin` });
    }
    const archive = makeZip(entries);
    const sampleBytes = 64 * 1024;
    expect(archive.length).toBeGreaterThan(363_241);
    expect(archive.subarray(0, sampleBytes).includes(Buffer.from("word/"))).toBe(false);
    expect(archive.subarray(-sampleBytes).includes(Buffer.from("word/"))).toBe(false);
    expect(await archiveMatchesExtension(".docx", source(archive), signal())).toBe(true);
  });

  it("refuse les packages dont les manifests ou Content_Types ne décrivent pas le type exact", async () => {
    const wrongDocx = ooxmlEntries(".docx");
    wrongDocx[0] = {
      name: "[Content_Types].xml",
      content: CONTENT_TYPES_XML("word/document.xml", "application/octet-stream"),
    };
    expect(await archiveMatchesExtension(".docx", source(makeZip(wrongDocx)), signal())).toBe(false);

    const wrongOdt = odfEntries(".odt");
    wrongOdt[0] = { name: "mimetype", content: "application/vnd.oasis.opendocument.spreadsheet" };
    expect(await archiveMatchesExtension(".odt", source(makeZip(wrongOdt)), signal())).toBe(false);
  });

  it("refuse les attributs critiques placés dans un namespace attaquant", async () => {
    const namespacedContentTypes = ooxmlEntries(".docx");
    namespacedContentTypes[0] = {
      name: "[Content_Types].xml",
      content: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types" xmlns:x="urn:attacker"><Override x:PartName="/word/document.xml" x:ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    };
    expect(await archiveMatchesExtension(".docx", source(makeZip(namespacedContentTypes)), signal())).toBe(false);

    const namespacedRelationships = ooxmlEntries(".docx");
    namespacedRelationships[1] = {
      name: "_rels/.rels",
      content: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships" xmlns:x="urn:attacker"><Relationship Id="rId1" x:Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" x:Target="word/document.xml"/></Relationships>`,
    };
    expect(await archiveMatchesExtension(".docx", source(makeZip(namespacedRelationships)), signal())).toBe(false);

    const namespacedOdfManifest = odfEntries(".odt");
    namespacedOdfManifest[1] = {
      name: "META-INF/manifest.xml",
      content: `<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" xmlns:x="urn:attacker"><manifest:file-entry x:full-path="/" x:media-type="application/vnd.oasis.opendocument.text"/></manifest:manifest>`,
    };
    expect(await archiveMatchesExtension(".odt", source(makeZip(namespacedOdfManifest)), signal())).toBe(false);
  });

  it("refuse les éléments sémantiques placés dans un namespace attaquant", async () => {
    const namespacedOverride = ooxmlEntries(".docx");
    namespacedOverride[0] = {
      name: "[Content_Types].xml",
      content: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types" xmlns:x="urn:attacker"><x:Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    };
    expect(await archiveMatchesExtension(".docx", source(makeZip(namespacedOverride)), signal())).toBe(false);

    const namespacedRelationship = ooxmlEntries(".docx");
    namespacedRelationship[1] = {
      name: "_rels/.rels",
      content: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships" xmlns:x="urn:attacker"><x:Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    };
    expect(await archiveMatchesExtension(".docx", source(makeZip(namespacedRelationship)), signal())).toBe(false);

    const namespacedOdfElement = odfEntries(".odt");
    namespacedOdfElement[1] = {
      name: "META-INF/manifest.xml",
      content: `<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" xmlns:x="urn:attacker"><x:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/></manifest:manifest>`,
    };
    expect(await archiveMatchesExtension(".odt", source(makeZip(namespacedOdfElement)), signal())).toBe(false);

    const namespacedThreeMfDefault: ZipFixtureEntry[] = [
      {
        name: "[Content_Types].xml",
        content: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types" xmlns:x="urn:attacker"><x:Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`,
      },
      {
        name: "_rels/.rels",
        content: RELATIONSHIPS_XML(
          "/3D/3dmodel.model",
          "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"
        ),
      },
      {
        name: "3D/3dmodel.model",
        content: '<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"/>',
      },
    ];
    expect(await archiveMatchesExtension(".3mf", source(makeZip(namespacedThreeMfDefault)), signal())).toBe(false);
  });

  it("refuse une pièce principale absente, non XML ou de racine/namespace incohérent", async () => {
    const nonXmlDocx = ooxmlEntries(".docx");
    nonXmlDocx[2] = { name: "word/document.xml", content: "not XML" };
    expect(await archiveMatchesExtension(".docx", source(makeZip(nonXmlDocx)), signal())).toBe(false);

    const wrongRootDocx = ooxmlEntries(".docx");
    wrongRootDocx[2] = {
      name: "word/document.xml",
      content: '<w:workbook xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
    };
    expect(await archiveMatchesExtension(".docx", source(makeZip(wrongRootDocx)), signal())).toBe(false);

    const wrongNamespaceThreeMf: ZipFixtureEntry[] = [
      {
        name: "[Content_Types].xml",
        content: CONTENT_TYPES_XML("3D/3dmodel.model", "application/vnd.ms-package.3dmanufacturing-3dmodel+xml"),
      },
      {
        name: "_rels/.rels",
        content: RELATIONSHIPS_XML("/3D/3dmodel.model", "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"),
      },
      { name: "3D/3dmodel.model", content: '<model xmlns="urn:attacker"/>' },
    ];
    expect(await archiveMatchesExtension(".3mf", source(makeZip(wrongNamespaceThreeMf)), signal())).toBe(false);

    const nonXmlOds = odfEntries(".ods");
    nonXmlOds[2] = { name: "content.xml", content: "not XML" };
    expect(await archiveMatchesExtension(".ods", source(makeZip(nonXmlOds)), signal())).toBe(false);
  });

  it("refuse traversal, chiffrement, CRC faux, ZIP64 et limites abusives", async () => {
    expect(await archiveMatchesExtension(".zip", source(makeZip([{ name: "../escape.txt", content: "x" }])), signal())).toBe(false);
    expect(await archiveMatchesExtension(".zip", source(makeZip([{ name: "encrypted.txt", content: "x", flags: 0x0001 }])), signal())).toBe(false);
    expect(await archiveMatchesExtension(".zip", source(makeZip([{ name: "bad-crc.txt", content: "x", crcOverride: 0x12345678 }])), signal())).toBe(false);

    const zip64Sentinel = makeZip([{ name: "proof.txt", content: "safe" }]);
    zip64Sentinel.writeUInt16LE(0xffff, zip64Sentinel.length - 22 + 10);
    expect(await archiveMatchesExtension(".zip", source(zip64Sentinel), signal())).toBe(false);

    const excessiveRatio = makeZip([{
      name: "bomb.txt",
      content: Buffer.alloc(2 * 1024 * 1024, 0x41),
      compression: "deflate",
    }]);
    expect(await archiveMatchesExtension(".zip", source(excessiveRatio), signal())).toBe(false);

    const tooManyEntries = makeZip(Array.from(
      { length: ARCHIVE_VALIDATION_LIMITS.maxEntries + 1 },
      (_, index) => ({ name: `entry-${index}.txt` })
    ));
    expect(await archiveMatchesExtension(".zip", source(tooManyEntries), signal())).toBe(false);

    expect(await archiveMatchesExtension(".zip", {
      path: "not-opened-because-size-is-rejected.zip",
      size: ARCHIVE_VALIDATION_LIMITS.maxFileBytes + 1,
    }, signal())).toBe(false);
  });
});
