/** Минимальные типы для adm-zip (пакет без bundled .d.ts в текущей сборке). */
declare module "adm-zip" {
  export default class AdmZip {
    constructor(input?: Buffer | string);
    extractAllTo(targetPath: string, overwrite?: boolean): void;
  }
}
