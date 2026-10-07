import PDFDocument from 'pdfkit';
import bwipjs from 'bwip-js';
import { HttpError } from '../../../utils/httpError';
import { readFinishedPackaging } from '../repository/finished-packaging.repository';
export { readFinishedPackaging, createFinishedPackaging, recordPackagingPrint, voidFinishedPackaging } from '../repository/finished-packaging.repository';
export async function finishedPackagingLabels(lotId: string, packagingId: string): Promise<Buffer> {
    const data = await readFinishedPackaging(lotId), record = data.records.find(r => r.id === packagingId);
    if (!record || record.voided)
        throw new HttpError(404, 'PACKAGING_NOT_FOUND', 'Conditionnement introuvable ou annulé.');
    const label = (record.policy as {
        label?: typeof data.lot & {
            ofNumber: string;
        };
    }).label;
    if (!label)
        throw new HttpError(409, 'PACKAGING_LABEL_SNAPSHOT_MISSING', 'Le conditionnement ne possède pas d’identité figée pour ses étiquettes.');
    const doc = new PDFDocument({ autoFirstPage: false });
    const chunks: Buffer[] = [];
    const result = new Promise<Buffer>((resolve, reject) => { doc.on('data', (part: Buffer) => chunks.push(part)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
    for (const [index, quantity] of record.portions.entries()) {
        doc.addPage({ size: [283.46, 170.08], margin: 15 });
        doc.fontSize(12).text(label.articleCode, { width: 195 }).fontSize(10).text(label.articleDesignation, { height: 24, width: 195 });
        doc.moveDown(0.4).fontSize(14).text(`${label.label} / ${index + 1}`, { width: 195 });
        doc.fontSize(10).text(`${quantity} pièces · ${index + 1}/${record.portions.length}`);
        doc.text(`Indice : ${label.index ?? 'sans indice'} · version ${label.internalVersion ?? 'inconnue'}`);
        doc.text(`OF : ${label.ofNumber} · provenance ${label.scope}`);
        const code = `CERP-PACK:${record.id}:${index + 1}`;
        doc.image(await bwipjs.toBuffer({ bcid: 'qrcode', text: code, scale: 3 }), 215, 15, { width: 52, height: 52 });
        doc.fontSize(6).text(code, { width: 250 });
    }
    doc.end();
    return result;
}
