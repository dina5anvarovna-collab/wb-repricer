import os from "node:os";
import path from "node:path";
import process from "node:process";
import { env } from "../config/env.js";
import {
  getWbWalletPrice,
  runWbBuyerProfileLogin,
  type BrowserKind,
} from "./wbWalletPriceParser.js";

type Args = {
  url?: string;
  nmId?: number;
  userDataDir: string;
  proxy?: string;
  region?: string;
  headless: boolean;
  login: boolean;
  browser: BrowserKind;
  /** Clear Chrome Singleton* lock files before launch (after Ctrl+C / crash). */
  unlockProfile: boolean;
  /** Login-only: ждать cookie без Enter в терминале (для запуска из веб-приложения). */
  loginAutoWait: boolean;
  /** После DOM — витрина/card.wb.ru (как в batch monitor). */
  showcaseCookies: boolean;
};

function parseArgs(argv: string[]): Args {
  const result: Partial<Args> = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      continue;
    }
    const [k, ...rest] = arg.slice(2).split("=");
    const raw = rest.join("=").trim();
    const v = raw.toLowerCase();
    if (k === "url") result.url = raw;
    if (k === "nmId") result.nmId = Number(raw);
    if (k === "userDataDir") result.userDataDir = raw;
    if (k === "proxy") result.proxy = raw;
    if (k === "region") result.region = raw;
    if (k === "headless") result.headless = v !== "false";
    if (k === "login") result.login = v !== "false";
    if (k === "browser") {
      if (v === "chrome" || v === "chromium") {
        result.browser = v as BrowserKind;
      }
    }
    if (k === "unlock-profile" || k === "unlockProfile") {
      result.unlockProfile =
        raw === "" || !["false", "0", "no"].includes(v);
    }
    if (k === "loginAutoWait" || k === "login-auto-wait") {
      result.loginAutoWait = v !== "false" && v !== "0" && v !== "no";
    }
    if (k === "showcaseCookies" || k === "showcase-cookies") {
      result.showcaseCookies = !(v === "false" || v === "0" || v === "no");
    }
  }
  const defaultBrowser: BrowserKind =
    env.BROWSER_EXECUTABLE_PATH.trim() || os.platform() === "darwin" ? "chrome" : "chromium";
  return {
    userDataDir: result.userDataDir || path.resolve(process.cwd(), ".wb-browser-profile"),
    url: result.url,
    nmId: result.nmId,
    proxy: result.proxy,
    region: result.region,
    headless: result.headless ?? true,
    login: result.login ?? false,
    browser: result.browser ?? defaultBrowser,
    unlockProfile: result.unlockProfile ?? false,
    loginAutoWait: result.loginAutoWait ?? false,
    showcaseCookies: result.showcaseCookies ?? false,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const nmInvalid =
    args.nmId !== undefined && (!Number.isFinite(args.nmId) || args.nmId <= 0);
  if (nmInvalid) {
    // eslint-disable-next-line no-console
    console.error(
      "Ошибка: --nmId должен быть числом (например --nmId=574507447), не текстом-заглушкой из инструкции.",
    );
    process.exit(1);
  }

  const loginOnly = args.login && !args.url && args.nmId === undefined;
  if (loginOnly) {
    if (args.headless) {
      // eslint-disable-next-line no-console
      console.error(
        "Режим только логина: нужно видимое окно — добавьте --headless=false",
      );
      process.exit(1);
    }
    const stdinTty = Boolean(process.stdin.isTTY);
    const useAutoWait = args.loginAutoWait || !stdinTty;
    if (!stdinTty && !args.loginAutoWait) {
      // eslint-disable-next-line no-console
      console.error(
        "[wb-wallet] stdin не TTY — включаю авто-ожидание входа по cookie (как для запуска из сайта).",
      );
    }
    const data = await runWbBuyerProfileLogin({
      userDataDir: args.userDataDir,
      proxy: args.proxy,
      headless: false,
      browser: args.browser,
      forceUnlockProfile: args.unlockProfile,
      waitForSessionAuto: useAutoWait,
    });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (!args.url && !args.nmId) {
    // eslint-disable-next-line no-console
    console.error(
      'Usage: node dist/walletDom/cli.js --login=true --headless=false [--userDataDir="./.wb-browser-profile"] [--browser=chrome|chromium]  # только сохранить сессию WB, без nmId\n' +
        '       node dist/walletDom/cli.js --nmId=<число> [--userDataDir="..."] [--headless=false] [--login=true] ...\n' +
        '       node dist/walletDom/cli.js --url="https://www.wildberries.ru/catalog/<nmId>/detail.aspx" ...',
    );
    process.exit(1);
  }
  const { unlockProfile, login, ...walletArgs } = args;
  const data = await getWbWalletPrice({
    ...walletArgs,
    headless: args.headless,
    loginMode: login,
    browser: args.browser,
    forceUnlockProfile: unlockProfile,
    fetchShowcaseWithCookies: args.showcaseCookies,
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(data, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
