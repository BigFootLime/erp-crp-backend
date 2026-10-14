import type {Pool} from 'pg';
import {z} from 'zod';
import {directoryProfileSchema} from './model';
import {sharedDirectoryClient,projectDirectoryProfile} from './site-runtime';
export async function synchronizeDirectoryRoster(db:Pool,session:string){
 const directory=sharedDirectoryClient();if(!directory)return;
 const profiles=z.array(directoryProfileSchema).parse(await directory.call('profile-roster',{directory_session:session}));
 for(const profile of profiles)await projectDirectoryProfile(db,profile);
}
