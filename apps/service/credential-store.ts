import {ApiError} from './api';
import {hash} from './storage';

export interface Vault { get(key:string):Promise<string|null>; set(key:string,value:string):Promise<void>; remove(key:string):Promise<void> }
export class OSVault implements Vault {
  constructor(private readonly profile:string) {}
  private async entry(key:string) {
    try {
      const {AsyncEntry}=await import('@napi-rs/keyring');
      return new AsyncEntry('X Smart Monitor',hash(this.profile).slice(0,20)+'-'+key);
    } catch {throw new ApiError(503,'VAULT_UNAVAILABLE','The OS credential store is unavailable.');}
  }
  async get(key:string) {
    try {return await(await this.entry(key)).getPassword()??null;}
    catch {throw new ApiError(503,'VAULT_UNAVAILABLE','Unlock your OS credential store and try again.');}
  }
  async set(key:string,value:string) {
    try {await(await this.entry(key)).setPassword(value);}
    catch {throw new ApiError(503,'VAULT_UNAVAILABLE','Unlock your OS credential store and try again.');}
  }
  async remove(key:string) {
    try {
      const entry=await this.entry(key);
      if(await entry.getPassword())await entry.deleteCredential();
    }
    catch {throw new ApiError(503,'VAULT_UNAVAILABLE','Unlock your OS credential store to finish removing the saved credential.');}
  }
}


export async function removeRetiredCredentials(profile:string) {
  const original=new OSVault(profile);
  const local=new OSVault(profile+':local-account');
  await original.remove('bearer');
  await original.remove('oauth-refresh');
  await local.remove('access');
  await local.remove('oauth-refresh');
}