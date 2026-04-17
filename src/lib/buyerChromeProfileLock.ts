/**
 * Один persistent userDataDir (.wb-browser-profile) нельзя открыть двумя Chrome одновременно
 * (SingletonLock). Мониторинг + «Обновить cookies» в UI иначе конфликтуют.
 */
let chain: Promise<unknown> = Promise.resolve();

export function runExclusiveBuyerChromeProfile<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(() => fn());
  chain = run.then(
    () => {},
    () => {},
  );
  return run;
}
