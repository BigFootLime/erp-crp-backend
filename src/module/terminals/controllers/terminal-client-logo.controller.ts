import { asyncHandler } from '../../../utils/asyncHandler';
import { HttpError } from '../../../utils/httpError';
import { sendSecureStoredFile } from '../../../shared/uploads/secure-download';
import { authorizeOfClientLogoRead } from '../../operational-media/services/operational-media.service';
import { mediaFilename } from '../../operational-media/repository/operational-media.repository';
import { operationContext } from '../repository/terminal-dossier.repository';
import { scopeSchema } from '../validators/terminals.validators';
import type { Request } from 'express';
async function logo(req: Request) {
    const p = scopeSchema.parse({ of_id: req.params.of_id, operation_id: req.params.operation_id });
    await operationContext(req.terminal!, p.of_id, p.operation_id);
    return { p, file: await authorizeOfClientLogoRead({ ofId: p.of_id, userId: req.user!.id }) };
}
export const clientLogoMetadata = asyncHandler(async (req, res) => {
    const { p, file } = await logo(req), application = req.terminal!.kind === 'CUTTING' ? 'cutting' : 'operator';
    res.json(file ? { id: file.asset.id, mime_type: file.mimeType, sha256: file.expectedSha256,
        download_path: `/terminals/${application}/ofs/${p.of_id}/operations/${p.operation_id}/client-logo/content`,
        available: true, name: 'Logo client', category: 'CLIENT_LOGO', source: 'MEDIA', version: null, title: null,
    } : null);
});
export const clientLogoContent = asyncHandler(async (req, res) => {
    const { file } = await logo(req);
    if (!file)
        throw new HttpError(404, 'MEDIA_NOT_FOUND', 'Logo client indisponible.');
    await sendSecureStoredFile(res, { ...file, filename: mediaFilename(file.asset), download: false });
});
