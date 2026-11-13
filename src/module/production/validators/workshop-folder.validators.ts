import { z } from "zod";
import { ofIdParam } from "./of-versioning.validators";

export const workshopFolderParams = ofIdParam.extend({ folderId: z.string().guid() });
export const workshopFolderCommand = z.object({}).strict();
