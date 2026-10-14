import {sharedDirectoryClient} from './site-runtime';
function column(alias:string,name:string){if(!/^[a-z][a-z0-9_]*$/i.test(alias))throw new Error('DIRECTORY_SQL_ALIAS_INVALID');return `${alias}.${name}`;}
export function directoryUsernameSql(alias='u'){const original=column(alias,'username');return sharedDirectoryClient()?`coalesce(${column(alias,'directory_username')},${original})`:original;}
export function directoryEmailSql(alias='u'){const original=column(alias,'email');return sharedDirectoryClient()?`coalesce(${column(alias,'directory_email')},${original})`:original;}
export function directoryRosterFilter(alias='u'){return sharedDirectoryClient()?`AND ${column(alias,'directory_profile_id')} IS NOT NULL`:'';}
