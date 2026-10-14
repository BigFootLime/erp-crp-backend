import { z } from "zod";
import { ofIdParam } from "./of-versioning.validators";

export const workshopFolderParams = ofIdParam.extend({ folderId: z.string().uuid() });
export const workshopFolderCommand = z.object({}).strict();
