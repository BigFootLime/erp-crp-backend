import { renderCerpDocument, type CerpDocumentHeader } from "./cerp-document";
import { documentFont } from "./document-fonts";
import { PDF_MODULE_ACCENTS, type PdfModule } from "./document-theme";

/** Transitional body adapter: shared identity/fonts/footer, original business values. */
export function renderCerpRawBody(header: CerpDocumentHeader, render: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return renderCerpDocument(header, ctx => {
    ctx.doc.x = 38;
    ctx.doc.y = ctx.y;
    render(ctx.doc);
  });
}

export function drawCerpRawSection(doc: PDFKit.PDFDocument, title: string, module: PdfModule): void {
  doc.font(documentFont(doc,true)).fontSize(10.5);
  const height=Math.max(28,doc.heightOfString(title,{width:493})+14);
  let y=doc.y+10;
  if(y+height+25>doc.page.height-doc.page.margins.bottom){doc.addPage();y=doc.y;}
  doc.save().rect(38,y,519.28,height).fill("#EFF3F6").rect(38,y,3,height).fill(PDF_MODULE_ACCENTS[module]).restore();
  doc.fillColor("#152E3D").text(title,50,y+7,{width:493});
  doc.x=38;doc.y=y+height+10;doc.font(documentFont(doc)).fontSize(10);
}
